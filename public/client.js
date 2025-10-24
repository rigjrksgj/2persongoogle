const ws = new WebSocket(`ws://${location.host}`);
const input = document.getElementById("searchInput");
const resultsList = document.getElementById("results");

// Send input to server
input.addEventListener("input", () => {
  ws.send(JSON.stringify({ type: "input", query: input.value }));
});

// Receive updates from server
ws.onmessage = (msg) => {
  const data = JSON.parse(msg.data);

  if (data.type === "update") {
    input.value = data.query;

    resultsList.innerHTML = "";
    data.results.forEach(r => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.textContent = r.text;
      li.appendChild(a);
      resultsList.appendChild(li);
    });
  }
};

ws.onopen = () => console.log("Connected to server!");
ws.onerror = (err) => console.error("WebSocket error:", err);
