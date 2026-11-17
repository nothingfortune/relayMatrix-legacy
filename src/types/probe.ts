import type { StickDirection, StickSector } from "./azeron.js";
import type { DeviceData } from "./profile.js";
import type { ProbeAssignment } from "../lib/probe.js";

export interface ProbePayload {
  generatedAt: string;
  profileName: string;
  /** The assumed maps, used for the diagram and for everything but the pins. */
  devices: Record<string, DeviceData>;
  /** Which device to sweep for each hand. */
  units: {
    hand: string;
    device: string;
    /** This unit's own keys, when its probe was built on its own export. */
    assignments?: ProbeAssignment[];
    stickAssignments?: ProbeAssignment[];
    /** The `invertXAxis` this unit's probe stick was written with (the compiler's). */
    invertXWritten?: boolean;
  }[];
  assignments: ProbeAssignment[];
  /** From the stick-only calibration profile: all eight sectors, 45-degree resolution. */
  stickAssignments: ProbeAssignment[];
}

export interface CapturedUnit {
  pins: Record<string, number>;
  stick: Partial<Record<StickDirection, StickDirection>>;
  /** Physical push -> the sector the firmware reported for it. */
  sectors?: Partial<Record<StickSector, StickSector>>;
  /**
   * The `invertXAxis` the probe held when the stick readings were taken (null: not known).
   * A reading is judged against this, not against the probe on the unit at the time it is
   * looked at, which may have been put back since.
   */
  stickX?: boolean | null;
}
