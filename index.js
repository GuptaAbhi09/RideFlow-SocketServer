const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

const server = http.createServer(app);

// Configure Socket.IO with CORS specifically allowing your Next.js app
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// A simple in-memory store for tracking connected users and their roles
// Structure: { socketId: { userId, role, status, isOnline, vehicleType, partnerStatus, latitude, longitude } }
const connectedUsers = new Map();

// Haversine formula to calculate distance in km between two lat/lng points
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return Infinity;
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2); 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); 
  return R * c; // Distance in km
}

io.on('connection', (socket) => {
  console.log(`[+] New Connection: ${socket.id}`);

  /**
   * 1. Authentication & Joining
   * The client should emit this immediately after connecting.
   */
  socket.on('register_user', (data) => {
    const { userId, role, isOnline, vehicleType, partnerStatus } = data; 
    
    // Preserve existing lat/lng if updating status
    const existing = connectedUsers.get(socket.id) || {};

    connectedUsers.set(socket.id, {
      ...existing,
      userId,
      role,
      status: 'online',
      isOnline: isOnline || false,
      vehicleType,
      partnerStatus,
      joinedAt: existing.joinedAt || new Date()
    });

    // Join a personal room for direct 1-to-1 messages (like a specific ride update)
    socket.join(`user_${userId}`);
    
    // Join a role-based room (e.g., all admins, all partners)
    socket.join(`role_${role}`);

    console.log(`[User Registered] ${userId} (${role}) via Socket ${socket.id}`);
    
    // Acknowledge back to the client
    socket.emit('registration_success', { status: 'online' });
  });

  /**
   * 2. Live Tracking / GPS Updates (Partners)
   */
  socket.on('update_location', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.role !== 'partner') return;

    const { latitude, longitude, heading } = data;
    
    // Save driver's current location in memory for dispatching
    user.latitude = latitude;
    user.longitude = longitude;
    connectedUsers.set(socket.id, user);

    // If the driver is on an active ride, emit strictly to that ride's room
    if (data.rideId) {
      io.to(`ride_${data.rideId}`).emit('driver_location_updated', {
        driverId: user.userId,
        latitude,
        longitude,
        heading
      });
    }
  });

  /**
   * 3. Ride Requests (Customers -> Partners)
   */
  socket.on('request_ride', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.role !== 'customer') return;

    console.log(`[Ride Request] from ${user.userId} for ${data.vehicleType}`);
    
    let driversFound = 0;

    // Filter connected users (The "Uber Algorithm")
    for (const [driverSocketId, driver] of connectedUsers.entries()) {
      if (
        driver.role === 'partner' &&
        driver.isOnline === true &&
        driver.partnerStatus === 'approved' &&
        driver.vehicleType === data.vehicleType
      ) {
        // If pickup coordinates are provided, calculate distance
        if (data.pickupLat && data.pickupLng && driver.latitude && driver.longitude) {
          const distance = calculateDistance(data.pickupLat, data.pickupLng, driver.latitude, driver.longitude);
          
          if (distance <= 5.0) { // Within 5km
            io.to(driverSocketId).emit('new_ride_request', {
              rideId: data.rideId,
              pickup: data.pickup,
              drop: data.drop,
              fare: data.fare,
              customerName: data.customerName,
              distanceToPickup: distance.toFixed(1)
            });
            driversFound++;
          }
        } else {
          // Fallback if no coordinates available: broadcast to matching vehicle types
          io.to(driverSocketId).emit('new_ride_request', {
            ...data
          });
          driversFound++;
        }
      }
    }

    if (driversFound === 0) {
      console.log(`[Ride Request] No drivers found for ${user.userId}`);
      socket.emit('no_drivers_found', { rideId: data.rideId });
    } else {
      console.log(`[Ride Request] Sent to ${driversFound} drivers`);
      // Tell the customer how many drivers it pinged (optional, for UI)
      socket.emit('drivers_notified', { count: driversFound });
    }
  });

  /**
   * 4. Ride Acceptance (Partner -> Customer)
   */
  socket.on('accept_ride', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.role !== 'partner') return;

    // Alert the specific customer that their ride was accepted
    io.to(`user_${data.customerId}`).emit('ride_accepted', {
      rideId: data.rideId,
      driverId: user.userId,
      driverName: data.driverName,
      vehicleDetails: data.vehicleDetails
    });

    // The driver and customer should now join a specific ride room for live tracking
    socket.join(`ride_${data.rideId}`);
  });

  /**
   * 5. Join Ride Room (Customer)
   */
  socket.on('join_ride', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user || user.role !== 'customer') return;
    
    socket.join(`ride_${data.rideId}`);
    console.log(`[Customer ${user.userId}] Joined tracking room: ride_${data.rideId}`);
  });

  /**
   * 6. Ride Cancellation
   */
  socket.on('cancel_ride', (data) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    // Broadcast to the specific ride room so anyone looking at the map gets kicked out
    io.to(`ride_${data.rideId}`).emit('ride_cancelled', {
      rideId: data.rideId,
      cancelledBy: user.role
    });

    // Also broadcast to the customer directly in case they haven't joined the ride room yet
    if (data.customerId) {
      io.to(`user_${data.customerId}`).emit('ride_cancelled', {
        rideId: data.rideId,
        cancelledBy: user.role
      });
    }

    console.log(`[Ride Cancelled] ${data.rideId} by ${user.role} (${user.userId})`);
  });

  /**
   * Disconnection Handling
   */
  socket.on('disconnect', () => {
    const user = connectedUsers.get(socket.id);
    if (user) {
      console.log(`[-] User Disconnected: ${user.userId} (${socket.id})`);
      connectedUsers.delete(socket.id);
      
      // If it was a partner, you might want to broadcast that they went offline
      if (user.role === 'partner') {
        // Emit offline status logic...
      }
    } else {
      console.log(`[-] Socket Disconnected: ${socket.id}`);
    }
  });
});

// Simple health check endpoint for Render/Vercel
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', activeConnections: connectedUsers.size });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO Server running on port ${PORT}`);
  console.log(`Allowed CORS Origin: ${process.env.CLIENT_URL || "http://localhost:3000"}`);
});
