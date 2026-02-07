import * as satellite from 'https://esm.sh/satellite.js@5.0.0';

let satRecords = [];

// Sources config
const SOURCES = [
    { name: "Active Sats", url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle', color: [0, 1, 0] },
    { name: "Fengyun 1C Debris", url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=1999-025&FORMAT=tle', color: [1, 0, 0] },
    { name: "Iridium 33 Debris", url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=iridium-33&FORMAT=tle', color: [1, 0, 0] },
    { name: "Cosmos 2251 Debris", url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-2251-debris&FORMAT=tle', color: [1, 0, 0] }
];

self.onmessage = function(e) {
    if (e.data.type === 'INIT') {
        initData();
    } else if (e.data.type === 'UPDATE') {
        propagatePositions(new Date(e.data.date));
    } else if (e.data.type === 'CHECK_RISK') {
        analyzeLaunchRisk(e.data.payload);
    }
};

async function initData() {
    try {
        const promises = SOURCES.map(src => fetch(src.url).then(r => r.text()).then(t => ({ text: t, config: src })));
        const results = await Promise.all(promises);
        
        satRecords = [];
        results.forEach(res => {
            const lines = res.text.split('\n').filter(l => l.trim() !== '');
            for (let i = 0; i < lines.length - 2; i += 3) {
                try {
                    const satrec = satellite.twoline2satrec(lines[i+1], lines[i+2]);
                    satRecords.push({
                        satrec: satrec,
                        name: lines[i].trim(),
                        type: res.config.name,
                        color: res.config.color,
                        satnum: lines[i+2].split(' ')[1]
                    });
                } catch (e) {}
            }
        });

        const colors = new Float32Array(satRecords.length * 3);
        const names = [];
        for (let i = 0; i < satRecords.length; i++) {
            const c = satRecords[i].color;
            colors[i*3] = c[0]; colors[i*3+1] = c[1]; colors[i*3+2] = c[2];
            names.push({ name: satRecords[i].name, type: satRecords[i].type, id: satRecords[i].satnum });
        }

        self.postMessage({ type: 'READY', count: satRecords.length, colors: colors, metadata: names });

    } catch (err) { console.error("Worker Error:", err); }
}

function propagatePositions(date) {
    const len = satRecords.length;
    const positions = new Float32Array(len * 3);
    const gmst = satellite.gstime(date);

    for (let i = 0; i < len; i++) {
        const posVel = satellite.propagate(satRecords[i].satrec, date);
        if (posVel.position) {
            positions[i*3] = posVel.position.x;
            positions[i*3+1] = posVel.position.y;
            positions[i*3+2] = posVel.position.z;
        } else {
            positions[i*3] = 99999; positions[i*3+1] = 99999; positions[i*3+2] = 99999;
        }
    }
    self.postMessage({ type: 'POSITIONS', positions: positions, gmst: gmst }, [positions.buffer]);
}

// --- UPDATED PHYSICS ENGINE (High Orbit) ---
function analyzeLaunchRisk(payload) {
    const { launchLat, launchLon, launchTimeMs } = payload;
    const launchDate = new Date(launchTimeMs);
    const risks = [];
    const rocketPath = [];

    // --- ROCKET PARAMETERS (Heavy Lift / Orbital Class) ---
    // Stage 1: 0 - 180s (Liftoff)
    // Stage 2: 180 - 900s (Orbital Insertion)
    
    let velocity = 0;      // m/s
    let altitude = 0;      // meters
    let downrangeDist = 0; // meters (Distance traveled East)
    let flightAngle = 90;  // Degrees
    
    // Physics constants
    const dt = 1.0; 
    const g = 9.81; 
    
    // Simulation Loop (1200 seconds = 20 minutes flight)
    for (let t = 0; t <= 1200; t += dt) {
        
        let acceleration = 0;

        if (t < 180) {
            // STAGE 1: Fighting Gravity
            // TWR: 1.2 -> 3.5
            const twr = 1.2 + (2.3 * (t / 180)); 
            acceleration = (twr * g) - g; 
            
            // Pitch Program: 90 -> 30 deg
            if(altitude > 500) {
                const progress = t / 180;
                flightAngle = 90 - (60 * progress);
            }
        } 
        else if (t < 900) {
            // STAGE 2: Orbital Insertion (Long Burn)
            // TWR: 0.8 -> 4.0 (Vacuum Engine)
            const twr = 0.8 + (3.2 * ((t - 180) / 720));
            acceleration = (twr * g); 
            
            // Flatten: 30 -> 0 deg
            const progress = (t - 180) / 720;
            flightAngle = 30 - (30 * progress);
        }
        else {
            // COAST (In Orbit) - Constant Velocity
            acceleration = 0;
            flightAngle = 0;
        }

        // Apply Limits (Orbital Velocity ~ 7800 m/s)
        if (velocity > 7800) acceleration = 0;

        // Integration
        const rad = flightAngle * (Math.PI / 180);
        velocity += acceleration * dt;
        
        const vVert = velocity * Math.sin(rad);
        const vHoriz = velocity * Math.cos(rad);
        
        altitude += vVert * dt;
        downrangeDist += vHoriz * dt;

        // Geodetic Conversion (Flying East)
        const lat = launchLat; 
        // 1 deg Lon = ~111km * cos(lat)
        const metersPerDeg = 111319 * Math.cos(lat * (Math.PI/180));
        const lon = launchLon + (downrangeDist / metersPerDeg);
        
        // ECI Conversion
        const simTime = new Date(launchDate.getTime() + t * 1000);
        const gmst = satellite.gstime(simTime);
        
        const rocketPosEcf = satellite.geodeticToEcf({
            latitude: lat * (Math.PI/180),
            longitude: lon * (Math.PI/180),
            height: altitude / 1000 // meters to km
        });
        
        const rocketPosEci = satellite.ecfToEci(rocketPosEcf, gmst);
        rocketPath.push(rocketPosEci);

        // Collision Check (every 5s)
        if (t % 5 === 0) {
            for (let i = 0; i < satRecords.length; i++) {
                const satPos = satellite.propagate(satRecords[i].satrec, simTime).position;
                if (satPos) {
                    const dx = satPos.x - rocketPosEci.x;
                    const dy = satPos.y - rocketPosEci.y;
                    const dz = satPos.z - rocketPosEci.z;
                    const distKm = Math.sqrt(dx*dx + dy*dy + dz*dz);

                    // Risk Threshold 50km
                    if (distKm < 50) { 
                        risks.push({
                            timeOffset: t,
                            distKm: distKm,
                            debrisName: satRecords[i].name,
                            debrisId: satRecords[i].satnum,
                            rocketPos: rocketPosEci,
                            debrisPos: satPos
                        });
                    }
                }
            }
        }
    }

    self.postMessage({
        type: 'RISK_RESULT',
        risks: risks,
        rocketPath: rocketPath
    });
}