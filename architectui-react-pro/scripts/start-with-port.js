const { spawn } = require('child_process');
const { findAvailablePort } = require('./find-port');

async function startReactApp() {
  try {
    const port = await findAvailablePort();
    console.log(`🚀 Starting React app on port ${port}...`);
    
    const env = { ...process.env, PORT: port.toString() };
    const child = spawn('npm', ['run', 'start'], {
      stdio: 'inherit',
      env: env,
      shell: true
    });

    child.on('error', (error) => {
      console.error('Error starting React app:', error);
      process.exit(1);
    });

    child.on('exit', (code) => {
      process.exit(code);
    });

  } catch (error) {
    console.error('Failed to find available port:', error.message);
    process.exit(1);
  }
}

startReactApp(); 