/* Throwaway: store the publish token, then publish.
   Token read from outside the repo so it never reaches a command line. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const cred = require("./credstore");

const TOKFILE = path.join(os.tmpdir(), "zo-tok.json");
const tok = JSON.parse(fs.readFileSync(TOKFILE, "utf8")).token;

const sharedBefore = cred.githubToken();
cred.setPublishToken(tok);

console.log("publish token stored :", cred.publishToken() === tok);
console.log("shared token intact  :", cred.githubToken() === sharedBefore,
            "(the one the QR hands out — must be unchanged)");
console.log("they are different   :", cred.publishToken() !== cred.githubToken());

const { publish } = require("./publish");
try{
  const out = publish({
    token: cred.publishToken(),
    message: "Publish the Zo Projects estate — hub and four dashboards",
  });
  console.log("\ncommit  :", out.commit);
  console.log("files   :", out.files.length);
  console.log("resent  :", !!out.resent, "| nothing:", !!out.nothing);
}catch(e){
  console.log("\nFAILED  :", e.message.split(tok).join("<TOKEN>"));
  process.exitCode = 1;
}
