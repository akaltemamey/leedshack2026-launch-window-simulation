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
        // New: Run Collision Analysis
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

        // Send metadata back
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

// --- NEW RISK ANALYSIS LOGIC ---
function analyzeLaunchRisk(payload) {
    const { launchLat, launchLon, launchTimeMs, ascentDuration } = payload;
    const launchDate = new Date(launchTimeMs);
    const risks = [];
    const rocketPath = [];

    // We check every 5 seconds of the flight
    const timeStep = 5; 
    
    // Simulate Rocket Ascent (Simplified Gravity Turn)
    for (let t = 0; t <= ascentDuration; t += timeStep) {
        const simTime = new Date(launchDate.getTime() + t * 1000);
        const gmst = satellite.gstime(simTime);

        // Rocket Physics Simulation (simplified)
        // 1. Altitude grows over time (0 to 400km)
        const progress = t / ascentDuration;
        const altitudeKm = 400 * Math.pow(progress, 1.5); // Curves up
        
        // 2. Downrange distance (flying East)
        const downrangeLat = launchLat; // Keep lat simple for now
        const downrangeLon = launchLon + (progress * 15); // Move 15 degrees East
        
        // 3. Convert Rocket Lat/Lon/Alt -> ECI Coordinates
        const rocketPosEcf = satellite.geodeticToEcf({
            latitude: downrangeLat * (Math.PI/180),
            longitude: downrangeLon * (Math.PI/180),
            height: altitudeKm
        });
        const rocketPosEci = satellite.ecfToEci(rocketPosEcf, gmst);
        
        // Save path for visualization
        rocketPath.push(rocketPosEci);

        // 4. CHECK COLLISIONS against all debris
        for (let i = 0; i < satRecords.length; i++) {
            const satPos = satellite.propagate(satRecords[i].satrec, simTime).position;
            
            if (satPos) {
                // Euclidean Distance
                const dx = satPos.x - rocketPosEci.x;
                const dy = satPos.y - rocketPosEci.y;
                const dz = satPos.z - rocketPosEci.z;
                const distKm = Math.sqrt(dx*dx + dy*dy + dz*dz);

                // RISK THRESHOLD: If debris is within 50km of rocket
                if (distKm < 100) { 
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

    self.postMessage({
        type: 'RISK_RESULT',
        risks: risks,
        rocketPath: rocketPath
    });
}