import { describe, expect, it } from "vitest";
import * as api from "../../src/index.js";
import * as sys from "../../src/tools/system.js";
import { makeBin, isPosix, tmpDir, withEnv, withPlatform } from "../helpers.js";

describe("public API", () => {
  it("exports the documented surface", () => {
    expect(Object.keys(api).sort()).toEqual(
      ["Agent", "DANGEROUS", "DEFAULT_MODEL", "VERSION", "buildServer", "buildToolset", "currentOs", "describePlatform", "needsConfirmation", "selectTools"],
    );
  });
});

describe.skipIf(!isPosix)("Windows process table (PowerShell JSON, fake powershell)", () => {
  const withPs = (json: string) => {
    const bin = tmpDir();
    makeBin(bin, "powershell", `cat <<'EOF'\n${json}\nEOF`);
    return <T>(fn: () => T): T => withPlatform("win32", () => withEnv({ PATH: `${bin}:/usr/bin:/bin` }, fn));
  };

  it("parses an array and a single object", async () => {
    const many = withPs('[{"Id":4,"ProcessName":"System","WorkingSet64":2097152},{"Id":10,"ProcessName":"chrome","WorkingSet64":314572800}]');
    const out = await many(() => sys.listProcesses());
    expect(out).toBe("pid\tname\tmemory\tuser\n10\tchrome\t300 MiB\t\n4\tSystem\t2 MiB\t");
    expect(await many(() => sys.listProcesses("CHR"))).toContain("chrome");
    const one = withPs('{"Id":7,"ProcessName":"solo","WorkingSet64":1048576}');
    expect(await one(() => sys.listProcesses())).toContain("7\tsolo\t1 MiB");
  });

  it("an empty listing and a missing PowerShell are reported, not swallowed", async () => {
    expect(await withPs("")(() => sys.listProcesses())).toBe("pid\tname\tmemory\tuser\n");
    await expect(withPlatform("win32", () => withEnv({ PATH: tmpDir() }, () => sys.listProcesses()))).rejects.toThrow();
  });

  it("kill_process reports a missing pid via the table", async () => {
    const ps = withPs("[]");
    expect(await ps(() => sys.killProcess(424242))).toBe("[error] no such process 424242");
  });
});
