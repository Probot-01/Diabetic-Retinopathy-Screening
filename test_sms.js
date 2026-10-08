require('dotenv').config();
const twilio = require('twilio');
const { buildMessage } = require('./central-system/backend/services/referralNotificationService');

const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_FROM;

if (!sid || !token || !from) {
  console.error("Error: Missing Twilio credentials in .env");
  process.exit(1);
}

const client = twilio(sid, token);

const testNumber = '+919819246311'; // User's number
const messageBody = buildMessage({ language: 'en', phcName: 'NetraSetu Test Clinic' });

console.log(`Attempting to send SMS to ${testNumber}...`);
console.log(`Message Body:\n"${messageBody}"`);

client.messages.create({
  body: messageBody,
  from: from,
  to: testNumber
})
.then(message => {
  console.log('\n✅ Success! SMS sent.');
  console.log('Message SID:', message.sid);
})
.catch(error => {
  console.error('\n❌ Failed to send SMS.');
  console.error(error.message);
  if (error.code === 21608) {
    console.error('Note: This is an unverified number on a trial account. You may need to verify it in your Twilio console.');
  }
});
