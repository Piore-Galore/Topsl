import os from "node:os";
import path from "node:path";
import { isWithin } from "../../packages/platform/system";

export interface TestProfileSettings {
  profile: string;
  /** Runtime qualifications run here instead of inside the profile. */
  qualificationDirectory: string | null;
}
/**
 * Development test profiles come from `TOPSL_TEST_PROFILE` and live in the OS
 * temporary directory. A packaged app ignores both variables.
 */
export function testProfileSettings(
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): TestProfileSettings | null {
  if (packaged || !env.TOPSL_TEST_PROFILE) return null;
  const profile = path.resolve(env.TOPSL_TEST_PROFILE);
  if (
    !isWithin(os.tmpdir(), profile) ||
    !path.basename(profile).startsWith("topsl-test-")
  )
    throw new Error(
      "Test profiles must be new topsl-test-* directories under the OS temporary directory.",
    );
  if (!env.TOPSL_TEST_QUALIFICATION_DIR)
    return { profile, qualificationDirectory: null };
  // Codex's workspace-write sandbox leaves temporary folders writable, so a
  // qualification inside the profile could not judge its outside write.
  const qualificationDirectory = path.resolve(env.TOPSL_TEST_QUALIFICATION_DIR);
  if (
    isWithin(os.tmpdir(), qualificationDirectory) ||
    isWithin("/tmp", qualificationDirectory) ||
    !path.basename(qualificationDirectory).startsWith("topsl-qualify-")
  )
    throw new Error(
      "Test qualification folders must be topsl-qualify-* directories outside the OS temporary directory and /tmp.",
    );
  return { profile, qualificationDirectory };
}
