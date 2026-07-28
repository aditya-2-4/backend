import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

console.log('🚀 Starting OpenCV Local Camera to Cloud AI Stream Bridge...');
const bridgeProcess = spawn(pythonCmd, ['ai-service/camera_bridge.py'], {
  cwd: __dirname,
  stdio: 'inherit'
});

bridgeProcess.on('error', (err) => {
  console.error('Failed to start OpenCV camera bridge:', err.message);
});

bridgeProcess.on('exit', (code) => {
  console.log(`OpenCV camera bridge exited with code ${code}`);
});
