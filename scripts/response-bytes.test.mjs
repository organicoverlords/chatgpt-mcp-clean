import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createResponseByteCounter } from "../dist/lib/response-bytes.js";

const sink=[];
const counter=createResponseByteCounter((n)=>sink.push(n));
assert.equal(counter.count(Buffer.from("abc")),3);
assert.equal(counter.count("åäö"),6,"count UTF-8 bytes, not JS characters");
assert.equal(counter.count(new Uint8Array([1,2,3,4])),4);
assert.equal(counter.total,13);
counter.finish();
assert.deepEqual(sink,[13],"emit exactly one final per-response byte count");
counter.finish();
assert.deepEqual(sink,[13]);
console.log("PASS response byte counter measures encoded response payload bytes exactly once");
