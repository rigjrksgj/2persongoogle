const express = require("express");
const fetch = require("node-fetch"); // needed to fetch Google
const path = require("path");
const app = express();

app.use(express.static(path.join(__dirname, "public"))); // serve /public

// Proxy Google route
app.get("/google", async (req, res) => {
  try {
    const response = await fetch("https://www.google.com");
    let html = await response.text();

    // Fix relative links
    html = html.replace(/href="\//g, 'href="https://www.google.com/');
    html = html.replace(/src="\//g, 'src="https://www.google.com/');

    res.send(html);
  } catch (err) {
    console.error(err);
    res.status(500).send("Failed to load Google");
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
