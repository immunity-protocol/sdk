import { Gossip } from "axl-pubsub";

const a = new Gossip({
  axlUrl: "http://localhost:9002",
  privateKeyPath: "/tmp/immunity-spoke-test/spoke1.pem",
});
const b = new Gossip({
  axlUrl: "http://localhost:9012",
  privateKeyPath: "/tmp/immunity-spoke-test/spoke2.pem",
});

a.on("error", (e) => console.error("[A error]", e.message));
b.on("error", (e) => console.error("[B error]", e.message));

await a.start();
await b.start();
console.log("[both started]");

let received: { topic: string; from: string; payload: string } | null = null;
await b.subscribe("test.*", (msg) => {
  received = {
    topic: msg.topic,
    from: msg.from.slice(0, 16),
    payload: new TextDecoder().decode(msg.payload),
  };
  console.log("[B received]", received);
});
console.log("[B subscribed test.*]");

console.log("[sleeping 5s for advertise]");
await new Promise((r) => setTimeout(r, 5000));

console.log("[A knownPeers]", a.knownPeers());
console.log("[A subs for test.hello]", a.subscribersFor("test.hello"));

const result = await a.publish("test.hello", new TextEncoder().encode("ping"));
console.log("[A published]", {
  id: result.id,
  sentTo: result.sentTo.length,
  failed: result.failed.length,
});
if (result.failed.length) {
  console.log(
    "  failed:",
    result.failed.map((f) => ({ pk: f.pubkey.slice(0, 16), err: f.error.message })),
  );
}

console.log("[waiting 8s for receipt]");
await new Promise((r) => setTimeout(r, 8000));

console.log("[final received]", received);
await a.stop();
await b.stop();
process.exit(received ? 0 : 1);
