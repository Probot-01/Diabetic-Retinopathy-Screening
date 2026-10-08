/**
 * Secrets on the phone -- the PC-link pairing key and the technician's PC
 * session token -- live in the OS keystore (Android Keystore / iOS Keychain,
 * via expo-secure-store), encrypted with a hardware-backed key where the device
 * has one. They are NOT kept in the app's SQLite file, which a backup or a
 * rooted phone can read.
 */
import * as SecureStore from 'expo-secure-store';

const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export async function secretGet(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key, OPTS);
}

export async function secretSet(key: string, value: string | null): Promise<void> {
  if (value === null) await SecureStore.deleteItemAsync(key, OPTS);
  else await SecureStore.setItemAsync(key, value, OPTS);
}
