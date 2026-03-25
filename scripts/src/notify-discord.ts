const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!webhookUrl) {
  console.error("DISCORD_WEBHOOK_URL is not set — skipping Discord notification.");
  process.exit(0);
}

const message = process.argv[2] || "🦔 Hedgelet has been updated!";

const payload = {
  username: "Hedgelet",
  avatar_url: "https://em-content.zobj.net/source/twitter/376/hedgehog_1f994.png",
  embeds: [
    {
      title: "🚀 Update Deployed",
      description: message,
      color: 0x8b5a3e,
      timestamp: new Date().toISOString(),
      footer: { text: "Hedgelet · hedgelet.replit.app" },
    },
  ],
};

const res = await fetch(webhookUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}

console.log("✅ Discord notified successfully.");
