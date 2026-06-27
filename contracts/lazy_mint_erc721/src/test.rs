use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env, String,
};

use crate::{DataKey, Error, LazyMint721, LazyMint721Client};

fn setup_test() -> (Env, LazyMint721Client<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LazyMint721, ());
    let client = LazyMint721Client::new(&env, &contract_id);
    let creator = Address::generate(&env);

    (env, client, creator)
}

#[test]
fn test_transfer_with_missing_balance_returns_error() {
    let (env, client, creator) = setup_test();

    // Initialize the contract
    let pubkey = BytesN::from_array(&env, &[0u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    // We manually set the Alice as owner in storage to simulate a state bug where
    // balance isn't incremented but ownership is recorded.
    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Owner(1), &alice);
        // We explicitly DO NOT set Alice's balance. It is missing.
    });

    // Try to transfer
    // Since Alice has no balance (is missing in storage), it should return an error
    // instead of silently succeeding and underflowing.
    let result = client.try_transfer(&alice, &bob, &1);

    assert_eq!(result, Err(Ok(Error::NotOwner)));
}

// ─── Signature Verification Error Handling Tests ─────────────────────────────

#[test]
fn test_invalid_signature_returns_proper_error() {
    let (env, client, creator) = setup_test();

    // Initialize the contract
    let pubkey = BytesN::from_array(&env, &[1u8; 32]); // Non-zero pubkey
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);

    // Create a voucher with valid data
    let voucher = crate::MintVoucher {
        token_id: 1,
        price: 100,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://test-uri"),
        uri_hash: BytesN::from_array(&env, &[0u8; 32]),
        valid_until: u64::MAX,
    };

    // Create an invalid signature (all zeros)
    let invalid_signature = BytesN::from_array(&env, &[0u8; 64]);

    // Try to redeem with invalid signature
    let result = client.try_redeem(&buyer, &voucher, &invalid_signature);

    // Should return an error (host abort from ed25519_verify)
    assert!(result.is_err());
}

#[test]
fn test_wrong_signature_format_returns_proper_error() {
    let (env, client, creator) = setup_test();

    // Initialize the contract
    let pubkey = BytesN::from_array(&env, &[2u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);

    // Create a voucher
    let voucher = crate::MintVoucher {
        token_id: 2,
        price: 200,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://test-uri-2"),
        uri_hash: BytesN::from_array(&env, &[1u8; 32]),
        valid_until: u64::MAX,
    };

    // Create a signature with wrong format (random bytes)
    let wrong_signature = BytesN::from_array(&env, &[255u8; 64]);

    // Try to redeem with wrong signature format
    let result = client.try_redeem(&buyer, &voucher, &wrong_signature);

    // Should return an error (host abort from ed25519_verify)
    assert!(result.is_err());
}

#[test]
fn test_signature_for_wrong_voucher_data_returns_proper_error() {
    let (env, client, creator) = setup_test();

    // Initialize the contract
    let pubkey = BytesN::from_array(&env, &[3u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);

    // Create original voucher
    let _original_voucher = crate::MintVoucher {
        token_id: 3,
        price: 300,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://test-uri-3"),
        uri_hash: BytesN::from_array(&env, &[2u8; 32]),
        valid_until: u64::MAX,
    };

    // Create modified voucher (different token_id)
    let modified_voucher = crate::MintVoucher {
        token_id: 999, // Different token_id
        price: 300,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://test-uri-3"),
        uri_hash: BytesN::from_array(&env, &[2u8; 32]),
        valid_until: u64::MAX,
    };

    // Use signature from original voucher but with modified voucher data
    // This would be a valid signature for the original voucher but invalid for the modified one
    let signature_for_original = BytesN::from_array(&env, &[42u8; 64]);

    // Try to redeem modified voucher with signature from original voucher
    let result = client.try_redeem(&buyer, &modified_voucher, &signature_for_original);

    // Should return an error (host abort from ed25519_verify)
    assert!(result.is_err());
}

#[test]
fn test_graceful_signature_error_handling_with_payment() {
    let (env, client, creator) = setup_test();

    // Initialize the contract
    let pubkey = BytesN::from_array(&env, &[4u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);

    // Create a voucher with non-zero price
    let voucher = crate::MintVoucher {
        token_id: 4,
        price: 500, // Non-zero price
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://test-uri-4"),
        uri_hash: BytesN::from_array(&env, &[3u8; 32]),
        valid_until: u64::MAX,
    };

    // Create an invalid signature
    let invalid_signature = BytesN::from_array(&env, &[99u8; 64]);

    // Try to redeem with invalid signature and payment
    let result = client.try_redeem(&buyer, &voucher, &invalid_signature);

    // Should return an error (host abort from ed25519_verify)
    // Error happens before payment transfer — safe
    assert!(result.is_err());
}

#[test]
fn test_transfer_with_zero_balance_returns_error() {
    let (env, client, creator) = setup_test();

    let pubkey = BytesN::from_array(&env, &[0u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Token Name"),
        &String::from_str(&env, "TKN"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    env.as_contract(&client.address, || {
        env.storage().persistent().set(&DataKey::Owner(1), &alice);
        // Explicitly set Alice's balance to 0
        env.storage()
            .persistent()
            .set(&DataKey::BalanceOf(alice.clone()), &0u64);
    });

    let result = client.try_transfer(&alice, &bob, &1);

    assert_eq!(result, Err(Ok(Error::NotOwner)));
}

#[test]
fn test_voucher_expired_returns_proper_error() {
    let (env, client, creator) = setup_test();

    let pubkey = BytesN::from_array(&env, &[5u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Expiry Test"),
        &String::from_str(&env, "EXP"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);

    env.ledger().with_mut(|li| li.sequence_number = 100);

    let voucher = crate::MintVoucher {
        token_id: 1,
        price: 0,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://expired"),
        uri_hash: BytesN::from_array(&env, &[5u8; 32]),
        valid_until: 50,
    };

    let signature = BytesN::from_array(&env, &[0u8; 64]);

    let result = client.try_redeem(&buyer, &voucher, &signature);

    assert_eq!(result, Err(Ok(Error::VoucherExpired)));
}

// ─── Issue #39 — Voucher replay protection tests ──────────────────────────────

fn setup_with_fee() -> (Env, LazyMint721Client<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(LazyMint721, ());
    let client = LazyMint721Client::new(&env, &contract_id);
    let creator = Address::generate(&env);
    (env, client, creator)
}

/// Marking a token_id as used then trying to redeem it returns VoucherAlreadyRedeemed.
#[test]
fn voucher_replay_rejected_with_already_redeemed_error() {
    let (env, client, creator) = setup_with_fee();

    let pubkey = BytesN::from_array(&env, &[10u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Replay Test"),
        &String::from_str(&env, "RPT"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    // Manually mark token_id 5 as redeemed (simulates a prior successful redemption)
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::UsedVoucher(5u64), &true);
    });

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);
    let voucher = crate::MintVoucher {
        token_id: 5,
        price: 0,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://replay"),
        uri_hash: BytesN::from_array(&env, &[0u8; 32]),
        valid_until: 0,
    };

    let sig = BytesN::from_array(&env, &[0u8; 64]);
    let result = client.try_redeem(&buyer, &voucher, &sig);
    assert_eq!(result, Err(Ok(Error::VoucherAlreadyRedeemed)));
}

/// is_voucher_redeemed returns false before and true after a successful nonce mark.
#[test]
fn is_voucher_redeemed_reflects_nonce_state() {
    let (env, client, creator) = setup_with_fee();

    let pubkey = BytesN::from_array(&env, &[11u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Nonce Test"),
        &String::from_str(&env, "NCT"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    assert!(!client.is_voucher_redeemed(&7u64));

    // Mark as redeemed directly
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::UsedVoucher(7u64), &true);
    });

    assert!(client.is_voucher_redeemed(&7u64));
}

/// Different token_ids (nonces) are independent — redeeming one does not block another.
#[test]
fn different_nonces_are_independent() {
    let (env, client, creator) = setup_with_fee();

    let pubkey = BytesN::from_array(&env, &[12u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Nonce Indep"),
        &String::from_str(&env, "NCI"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    // Mark token_id 1 as used
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::UsedVoucher(1u64), &true);
    });

    // token_id 2 must still be unredeemed
    assert!(client.is_voucher_redeemed(&1u64));
    assert!(!client.is_voucher_redeemed(&2u64));

    // Trying to redeem token_id 2 should fail due to bad signature (not replay)
    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);
    let voucher2 = crate::MintVoucher {
        token_id: 2,
        price: 0,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://token2"),
        uri_hash: BytesN::from_array(&env, &[0u8; 32]),
        valid_until: 0,
    };
    let bad_sig = BytesN::from_array(&env, &[0u8; 64]);
    let result2 = client.try_redeem(&buyer, &voucher2, &bad_sig);
    // Should fail with host abort (invalid signature), NOT VoucherAlreadyRedeemed
    assert!(result2.is_err());
    // Confirm it's not a VoucherAlreadyRedeemed
    assert_ne!(result2, Err(Ok(Error::VoucherAlreadyRedeemed)));
}

/// Replay is rejected BEFORE signature verification (check ordering preserved).
#[test]
fn replay_check_precedes_signature_verification() {
    let (env, client, creator) = setup_with_fee();

    let pubkey = BytesN::from_array(&env, &[13u8; 32]);
    let royalty_receiver = Address::generate(&env);
    let fee_receiver = Address::generate(&env);
    client.initialize(
        &creator,
        &pubkey,
        &String::from_str(&env, "Order Test"),
        &String::from_str(&env, "ORD"),
        &1000u64,
        &0u32,
        &royalty_receiver,
        &fee_receiver,
        &0u32,
    );

    // Mark token 3 as already redeemed
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::UsedVoucher(3u64), &true);
    });

    let buyer = Address::generate(&env);
    let currency = Address::generate(&env);
    let voucher = crate::MintVoucher {
        token_id: 3,
        price: 0,
        currency: currency.clone(),
        uri: String::from_str(&env, "ipfs://order"),
        uri_hash: BytesN::from_array(&env, &[0u8; 32]),
        valid_until: 0,
    };

    // Even with a completely wrong signature, we get VoucherAlreadyRedeemed (not a host abort)
    let any_sig = BytesN::from_array(&env, &[99u8; 64]);
    let result = client.try_redeem(&buyer, &voucher, &any_sig);
    assert_eq!(result, Err(Ok(Error::VoucherAlreadyRedeemed)));
}
