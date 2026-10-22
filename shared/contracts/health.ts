// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Health/liveness contract.
 *
 * `/api/health/live` answers "is this process alive" and must not touch the
 * database. `/api/health/ready` answers "can this process serve traffic" and
 * checks dependencies.
 *
 * Neither endpoint may disclose connection strings, hosts, ports, usernames,
 * driver versions or raw driver error text.
 */

export type DependencyState = "up" | "down";

export interface LiveHealth {
  status: "ok";
  service: string;
  version: string;
  uptimeSeconds: number;
}

export interface ReadyHealth {
  status: "ok" | "degraded";
  service: string;
  version: string;
  uptimeSeconds: number;
  checks: {
    /** Logical name only — never the DSN. */
    database: DependencyState;
  };
}

/** Stable logical name for the primary datastore dependency. */
export const DB_DEPENDENCY_NAME = "database" as const;
