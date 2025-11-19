const io = require('socket.io-client');

const socketUrl = process.env.SOCKET_URL || 'http://localhost:3100';

console.log('Testing Socket.io connection to:', socketUrl);

const socket = io(socketUrl, {
  transports: ['websocket', 'polling'],
  reconnection: false,
  timeout: 5000
});

socket.on('connect', () => {
  console.log('✅ Connected! Socket ID:', socket.id);
  
  // Test startChat
  console.log('Testing startChat event...');
  socket.emit('startChat');
  
  // Test message
  setTimeout(() => {
    console.log('Testing message event...');
    socket.emit('message', { message: 'Test message' });
  }, 1000);
});

socket.on('connect_error', (error) => {
  console.error('❌ Connection error:', error.message);
  console.error('Error details:', error);
});

socket.on('error', (error) => {
  console.error('❌ Socket error:', error);
});

socket.on('response', (data) => {
  console.log('✅ Received response:', data);
});

socket.on('typing', (data) => {
  console.log('📝 Typing indicator:', data);
});

socket.on('stopTyping', (data) => {
  console.log('⏹️ Stop typing:', data);
});

socket.on('disconnect', (reason) => {
  console.log('🔌 Disconnected:', reason);
});

// Timeout after 10 seconds
setTimeout(() => {
  console.log('Test completed');
  socket.disconnect();
  process.exit(0);
}, 10000);

