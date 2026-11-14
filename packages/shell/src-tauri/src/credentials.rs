use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use crate::{commands::NativeError, origin::CanonicalOrigin};

const SERVICE: &str = "run.hundredfold.shell.gateway";

#[derive(Clone, Deserialize, Serialize)]
pub struct GatewayCredential {
    pub cookie_header: String,
    pub device_id: String,
}

pub trait CredentialStore: Send + Sync {
    fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError>;
    fn put(
        &self,
        origin: &CanonicalOrigin,
        credential: &GatewayCredential,
    ) -> Result<(), NativeError>;
    fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError>;
}

pub type SharedCredentialStore = Arc<dyn CredentialStore>;

pub struct OsCredentialStore;

fn account(origin: &CanonicalOrigin) -> String {
    format!("{:x}", Sha256::digest(origin.as_str().as_bytes()))
}

fn entry(origin: &CanonicalOrigin) -> Result<keyring::Entry, NativeError> {
    keyring::Entry::new(SERVICE, &account(origin)).map_err(|_| NativeError::credential_store())
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError> {
        match entry(origin)?.get_password() {
            Ok(secret) => serde_json::from_str(&secret)
                .map(Some)
                .map_err(|_| NativeError::credential_store()),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(NativeError::credential_store()),
        }
    }

    fn put(
        &self,
        origin: &CanonicalOrigin,
        credential: &GatewayCredential,
    ) -> Result<(), NativeError> {
        let secret =
            serde_json::to_string(credential).map_err(|_| NativeError::credential_store())?;
        entry(origin)?
            .set_password(&secret)
            .map_err(|_| NativeError::credential_store())
    }

    fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError> {
        match entry(origin)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(_) => Err(NativeError::credential_store()),
        }
    }
}

#[cfg(test)]
pub mod test_store {
    use super::{account, CanonicalOrigin, CredentialStore, GatewayCredential};
    use crate::commands::NativeError;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    pub struct MemoryCredentialStore(Mutex<HashMap<String, GatewayCredential>>);

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, origin: &CanonicalOrigin) -> Result<Option<GatewayCredential>, NativeError> {
            Ok(self.0.lock().unwrap().get(&account(origin)).cloned())
        }

        fn put(
            &self,
            origin: &CanonicalOrigin,
            credential: &GatewayCredential,
        ) -> Result<(), NativeError> {
            self.0
                .lock()
                .unwrap()
                .insert(account(origin), credential.clone());
            Ok(())
        }

        fn delete(&self, origin: &CanonicalOrigin) -> Result<bool, NativeError> {
            Ok(self.0.lock().unwrap().remove(&account(origin)).is_some())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{account, test_store::MemoryCredentialStore, CredentialStore, GatewayCredential};
    use crate::origin::CanonicalOrigin;

    #[test]
    fn the_keyring_account_is_derived_from_the_exact_origin_and_port() {
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        let https = CanonicalOrigin::parse("https://gateway.example:7779").unwrap();
        assert_ne!(account(&a), account(&b));
        assert_ne!(account(&a), account(&https));
        assert_eq!(
            account(&a),
            account(&CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap())
        );
    }

    #[test]
    fn credentials_are_isolated_by_exact_origin_and_port() {
        let store = MemoryCredentialStore::default();
        let a = CanonicalOrigin::parse("http://127.0.0.1:7779").unwrap();
        let b = CanonicalOrigin::parse("http://127.0.0.1:7780").unwrap();
        store
            .put(
                &a,
                &GatewayCredential {
                    cookie_header: "auth=secret-a".into(),
                    device_id: "device-a".into(),
                },
            )
            .unwrap();
        assert!(store.get(&b).unwrap().is_none());
        assert_eq!(store.get(&a).unwrap().unwrap().device_id, "device-a");
        assert!(!store.delete(&b).unwrap());
        assert!(store.delete(&a).unwrap());
        assert!(store.get(&a).unwrap().is_none());
    }
}
