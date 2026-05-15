const functions = require('firebase-functions');
const admin = require('firebase-admin');
const vision = require('@google-cloud/vision');

admin.initializeApp();
const visionClient = new vision.ImageAnnotatorClient();

const FLAGGED = new Set(['LIKELY', 'VERY_LIKELY']);

exports.moderateProfilePhoto = functions.storage.object().onFinalize(async (object) => {
  const filePath = object.name;
  if (!filePath || !filePath.startsWith('profilePictures/')) return null;

  const parts = filePath.split('/');
  if (parts.length < 3) return null;
  const uid = parts[1];

  const gcsUri = `gs://${object.bucket}/${filePath}`;

  try {
    const [result] = await visionClient.safeSearchDetection(gcsUri);
    const safe = result.safeSearchAnnotation;

    const isFlagged = safe && (
      FLAGGED.has(safe.adult) ||
      FLAGGED.has(safe.violence) ||
      FLAGGED.has(safe.racy) ||
      FLAGGED.has(safe.medical)
    );

    if (isFlagged) {
      await admin.storage().bucket(object.bucket).file(filePath).delete();
      await admin.database().ref(`studentProfiles/${uid}/photoURL`).set(null);
      await admin.database().ref('moderationLog').push({
        uid,
        filePath,
        time: new Date().toISOString(),
        scores: {
          adult: safe.adult || 'UNKNOWN',
          violence: safe.violence || 'UNKNOWN',
          racy: safe.racy || 'UNKNOWN',
          medical: safe.medical || 'UNKNOWN',
        },
      });
      console.log(`Removed flagged photo for uid ${uid}:`, safe);
    }

    return null;
  } catch (err) {
    console.error('Vision API moderation error:', err);
    return null;
  }
});
