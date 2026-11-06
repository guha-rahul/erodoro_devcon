import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { Attribution } from "ox/erc8021";

const load = (file, imports, process) => {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync(new URL(file, import.meta.url), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) => {
        if (!(name in imports)) throw new Error(`Unexpected import ${name}`);
        return imports[name];
      },
      Date,
      console,
      process,
    },
  );
  return exports;
};

const withCode = load("../lib/builder-code.ts", { "ox/erc8021": { Attribution } }, {
  env: { NEXT_PUBLIC_BUILDER_CODE: "erodoro, base-app ,NOT VALID!," },
});
const withoutCode = load("../lib/builder-code.ts", { "ox/erc8021": { Attribution } }, { env: {} });

// --- Codes are validated, never guessed ------------------------------------
assert.equal(withCode.parseBuilderCodes("erodoro,base-app").join(","), "erodoro,base-app");
assert.equal(withCode.parseBuilderCodes("Erodoro").length, 0, "uppercase is rejected");
assert.equal(withCode.parseBuilderCodes("has space").length, 0);
assert.equal(withCode.parseBuilderCodes("").length, 0);
assert.equal(withCode.parseBuilderCodes(undefined).length, 0);

// --- A configured code produces a decodable ERC-8021 suffix ----------------
const suffix = withCode.builderCodeSuffix();
assert.match(suffix, /^0x[0-9a-fA-F]+$/);
assert.equal(Attribution.fromData(suffix).codes.join(","), "erodoro,base-app");

// --- No code means no suffix, so nothing is misattributed -------------------
assert.equal(withoutCode.builderCodeSuffix(), null);
assert.equal(withCode.builderCodeSuffix(""), null);
assert.equal(withCode.builderCodeSuffix("UPPER"), null);

console.log("Builder Code checks passed: code validation, decodable ERC-8021 suffix, and no suffix when unconfigured.");
