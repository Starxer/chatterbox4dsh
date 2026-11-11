import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Create a unique temporary directory and resolve it to its REAL path.
 *
 * The plugin under test resolves paths with `realpath` (symlink and 8.3-safe
 * containment checks), but Windows hands `os.tmpdir()` back as an 8.3 short
 * name — `C:\Users\RUNNER~1\AppData\Local\Temp`. A fixture that kept the short
 * spelling would then never compare equal to the long spelling the code
 * produces, which is what made the `windows-latest` leg report eleven
 * path-string mismatches on otherwise platform-independent behaviour.
 *
 * @param prefix - directory-name prefix, as `mkdtemp` takes it.
 * @returns the temporary directory's real absolute path.
 */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}
