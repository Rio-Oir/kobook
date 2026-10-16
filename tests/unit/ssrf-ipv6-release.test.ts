// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress} from '../../server/src/lib/ssrf-guard.js';
test('IPv6 alternate spellings and transition addresses cannot hide internal destinations',()=>{
 for(const ip of ['::ffff:127.0.0.1','::ffff:7f00:1','0:0:0:0:0:0:0:1','0:0:0:0:0:ffff:7f00:1','ff02::1','fec0::1','64:ff9b::7f00:1','2001::1','2001:db8::1','3fff::1','fe80::1%eth0']) assert.equal(isPublicAddress(ip),false,ip);
 for(const ip of ['2606:4700:4700::1111','2001:4860:4860::8888','2a00:1450:4001::1']) assert.equal(isPublicAddress(ip),true,ip);
});
