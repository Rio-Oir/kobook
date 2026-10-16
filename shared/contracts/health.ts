// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Health/liveness contract.
 *
 * `/api/health/live` answers "is this process alive" and must not touch a
 * database. It is the whole of this service's health surface: the process has
 * no database, so a readiness probe is not "unimplemented" but *absent*, and
 * the acceptance run asserts it is a 404 rather than an optimistic `ok` that
 * no dependency was ever checked for.
 *
 * A service that does have dependencies would answer `/api/health/ready` with
 * a readiness shape of its own; that contract belongs with those
 * dependencies, not here.
 *
 * Neither endpoint may disclose connection strings, hosts, ports, usernames,
 * driver versions or raw driver error text.
 */

export interface LiveHealth {
  status: "ok";
  service: string;
  version: string;
  uptimeSeconds: number;
}
