import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PI_API_SNAPSHOT } from "../src/index.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("docs: the README and the pi alignment register carry the same verified date", () => {
	assert.ok(read("README.md").includes(PI_API_SNAPSHOT), "README loses the last-verified date");
	assert.match(
		read("docs/pi-api-alignment.md"),
		new RegExp(`Last verified \\*\\*${PI_API_SNAPSHOT}\\*\\*`),
		"alignment register loses the last-verified date",
	);
});

test("docs: the register names the pi release the README claims", () => {
	assert.match(read("README.md"), /\*\*pi 1\.5\.1\*\*/);
	assert.match(read("docs/pi-api-alignment.md"), /\| \*\*1\.5\.1\*\* \|/);
});

test("docs: the declared Node floor matches pi 1.5.1's own floor", () => {
	const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
	assert.equal(pkg.engines?.node, ">=22.19");
});
