import * as satellite from 'satellite.js';

// Assuming you called fetchTLEData() and stored result in `tleData`
function createSatRecs(tleData) {
    const satRecs = [];

    tleData.forEach(sat => {
        try {
            // twoline2satrec converts the text strings into math-ready objects
            const satrec = satellite.twoline2satrec(sat.line1, sat.line2);
            
            // Store the record AND the name for your UI labels
            satRecs.push({
                satrec: satrec,
                name: sat.name
            });
        } catch (err) {
            // Some TLEs might be malformed; skip them
            console.warn(`Error parsing satellite ${sat.name}`);
        }
    });

    return satRecs;
}