const socket = new WebSocket(
  location.origin.replace(/^http/, "ws")
);

const iframe = document.getElementById("sharedFrame");
const iframeWindow = iframe.contentWindow;

// Capture inputs
document.addEventListener("keydown", (e) => {
  socket.send(JSON.stringify({ type: "keydown", key: e.key }));
});
document.addEventListener("keyup", (e) => {
  socket.send(JSON.stringify({ type: "keyup", key: e.key }));
});
document.addEventListener("scroll", () => {
  socket.send(JSON.stringify({ type: "scroll", scrollY: window.scrollY }));
});
document.addEventListener("click", (e) => {
  socket.send(JSON.stringify({ type: "click", x: e.clientX, y: e.clientY }));
});

// Replay remote events
socket.onmessage = (msg) => {
  const data = JSON.parse(msg.data);
  switch (data.type) {
    case "keydown":
      iframeWindow.document.dispatchEvent(new KeyboardEvent("keydown", { key: data.key }));
      break;
    case "keyup":
      iframeWindow.document.dispatchEvent(new KeyboardEvent("keyup", { key: data.key }));
      break;
    case "scroll":
      window.scrollTo(0, data.scrollY);
      break;
    case "click":
      const evt = new MouseEvent("click", { clientX: data.x, clientY: data.y });
      iframeWindow.document.dispatchEvent(evt);
      break;
  }
};
