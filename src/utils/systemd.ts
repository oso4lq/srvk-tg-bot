// src/utils/systemd.ts

import { exec } from "child_process";
import { promisify } from "util";
import { SYSTEMD_SERVICE } from "../config/config";
import { parseSystemdProps } from "./format";

const execAsync = promisify(exec);

// ─── Systemd утилиты ────────────────────────────────────────

export async function getServiceTrafficBytes(): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `systemctl show ${SYSTEMD_SERVICE} --property=IPIngressBytes,IPEgressBytes 2>/dev/null`
    );
    const props = parseSystemdProps(stdout);
    const ingress = parseInt(props.IPIngressBytes || "0", 10);
    const egress = parseInt(props.IPEgressBytes || "0", 10);
    return (isNaN(ingress) ? 0 : ingress) + (isNaN(egress) ? 0 : egress);
  } catch {
    return 0;
  }
}
