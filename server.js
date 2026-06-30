const https = require('https');
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname)));
app.use('/rive', express.static(path.join(__dirname, 'node_modules/@rive-app/canvas-lite')));

const server = https.createServer(
  {
    key: fs.readFileSync(path.join(__dirname, 'localhost+1-key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'localhost+1.pem')),
  },
  app
);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AR prototype running at:`);
  console.log(`  https://localhost:${PORT}  (desktop)`);
  console.log(`  https://192.168.1.8:${PORT}  (phone, same WiFi)`);
});
