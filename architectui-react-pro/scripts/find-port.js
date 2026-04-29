const net = require('net');
const http = require('http');

function checkPort(port) {
  return new Promise((resolve) => {
    // First check if port is bound
    const server = net.createServer();
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        resolve(false); // Port is in use
      } else {
        resolve(false); // Other error, assume port is not available
      }
    });
    
    server.listen(port, () => {
      server.close(() => {
        // Port is bindable, but check if there's an HTTP service
        checkHttpService(port).then(hasHttpService => {
          resolve(!hasHttpService); // Port is available if no HTTP service
        });
      });
    });
  });
}

function checkHttpService(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',
      port: port,
      method: 'GET',
      timeout: 1000
    }, (res) => {
      resolve(true); // HTTP service is running
    });
    
    req.on('error', () => {
      resolve(false); // No HTTP service
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve(false); // No HTTP service
    });
    
    req.end();
  });
}

async function findAvailablePort(startPort = 3000, endPort = 3099) {
  for (let port = startPort; port <= endPort; port++) {
    const isAvailable = await checkPort(port);
    if (isAvailable) {
      return port;
    }
  }
  throw new Error(`No available port found between ${startPort} and ${endPort}`);
}

module.exports = { findAvailablePort };

// If run directly
if (require.main === module) {
  findAvailablePort()
    .then(port => {
      console.log(port);
      process.exit(0);
    })
    .catch(err => {
      console.error('Error finding port:', err.message);
      process.exit(1);
    });
} 