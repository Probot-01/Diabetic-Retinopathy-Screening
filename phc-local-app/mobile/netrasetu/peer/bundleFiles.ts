/**
 * Moving data by hand when there is no network at all: the export bundle is
 * written to a file and handed to Android's share sheet (USB cable, SD card,
 * Bluetooth, Nearby Share); an incoming bundle is picked from the file system.
 * The file is sealed for the paired PC (peer/replicate.ts buildBundle), so a
 * lost memory card exposes nothing.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { buildBundle, importBundle, Bundle } from './replicate';

export async function exportBundleToShare(): Promise<{ records: number; images: number }> {
  const { bundle, records, images } = await buildBundle();
  const name = `netrasetu-${bundle.fromDevice}-${bundle.createdAt.replace(/[:.]/g, '-')}.nsbundle`;
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  f.write(JSON.stringify(bundle));
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, { mimeType: 'application/octet-stream', dialogTitle: 'Save or send the NetraSetu bundle' });
  }
  return { records, images };
}

export async function importBundleFromPicker(): Promise<{ applied: number; skipped: number; records: number } | null> {
  const picked = await File.pickFileAsync();
  const file = Array.isArray(picked) ? picked[0] : picked;
  if (!file) return null;
  const bundle = JSON.parse(await file.text()) as Bundle;
  return importBundle(bundle);
}
