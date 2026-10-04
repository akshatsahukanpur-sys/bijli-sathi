require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Technician = require('./models/Technician');
const KESCOAdmin = require('./models/KESCOAdmin');

async function cleanup() {
  let uri = process.env.MONGO_URI;
  // Handle stale shell env virs09m -> use .env file's tacqt1y
  if (uri && uri.includes('virs09m')) {
    try {
      const fs = require('fs');
      const path = require('path');
      const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
      const m = envFile.match(/MONGO_URI\s*=\s*(.+)/);
      if (m) {
        const fileUri = m[1].trim();
        if (fileUri && !fileUri.includes('virs09m')) {
          console.log('Overriding stale MONGO_URI virs09m with .env tacqt1y');
          uri = fileUri;
        }
      }
    } catch {}
  }
  if (!uri) {
    console.error('MONGO_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected to DB');

  const isValidPhone = (p) => {
    const d = String(p || '').replace(/\D/g, '');
    return d.length >= 10;
  };

  // Citizens
  const users = await User.find({});
  let delUsers = 0;
  for (const u of users) {
    if (!isValidPhone(u.phone)) {
      console.log(`Deleting User ${u._id} meter:${u.meterNumber} phone:${u.phone}`);
      await User.deleteOne({ _id: u._id });
      // Also delete their complaints? Optional, but we should keep complaints for audit? For now keep complaints.
      delUsers++;
    }
  }

  // Technicians
  const techs = await Technician.find({});
  let delTechs = 0;
  for (const t of techs) {
    if (!isValidPhone(t.phone)) {
      console.log(`Deleting Technician ${t._id} id:${t.technicianId} phone:${t.phone}`);
      await Technician.deleteOne({ _id: t._id });
      delTechs++;
    }
  }

  // KESCO Admins
  const kescos = await KESCOAdmin.find({});
  let delKescos = 0;
  for (const k of kescos) {
    if (!isValidPhone(k.phone)) {
      console.log(`Deleting KESCO ${k._id} reg:${k.registrationNumber} phone:${k.phone}`);
      await KESCOAdmin.deleteOne({ _id: k._id });
      delKescos++;
    }
  }

  console.log(`Done. Deleted: Users=${delUsers}, Technicians=${delTechs}, KESCO=${delKescos}`);
  console.log(`Remaining: Users=${await User.countDocuments()}, Technicians=${await Technician.countDocuments()}, KESCO=${await KESCOAdmin.countDocuments()}`);
  await mongoose.disconnect();
  process.exit(0);
}

cleanup().catch(e => { console.error(e); process.exit(1); });
