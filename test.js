// Replace this with your real 'verifyTelebirrReceipt' function or keep this test dummy
async function verifyTelebirrReceipt(transactionNumber, expectedTo, expectedAmount) {
  console.log(`Verifying receipt. Txn: ${transactionNumber}, To: ${expectedTo}, Amount: ${expectedAmount}`);
  // Dummy: simulate verification success if matches
  return transactionNumber === "CJ90DLPKBK" && expectedAmount === 150;
}

// Parser function to extract amount and transaction number from Telebirr SMS message
function parseTelebirrMessage(message) {
  if (!message) return { amount: null, transactionNumber: null };

  // Match amount after "ETB"
  const amountMatch = message.match(/ETB\s*([\d.,]+)/i);

  // Match transaction number after "Your transaction number is"
  const txnMatch = message.match(/Your transaction number is\s*([A-Za-z0-9]+)/i);

  return {
    amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
    transactionNumber: txnMatch ? txnMatch[1].trim() : null
  };
}

// Test the parser and verification with a sample message
async function test() {
  const sampleMessage = `Dear KELEMUWA 
You have transferred ETB 150.00 to NATNAEL GIRMA (2519****4350) on 09/10/2025 19:09:52. Your transaction number is CJ90DLPKBK. The service fee is  ETB 1.74 and  15% VAT on the service fee is ETB 0.26. Your current E-Money Account  balance is ETB 27.53. To download your payment information please click this link: https://transactioninfo.ethiotelecom.et/receipt/CJ90DLPKBK.

Thank you for using telebirr
Ethio telecom`;

  const { amount, transactionNumber } = parseTelebirrMessage(sampleMessage);

  console.log("Parsed amount:", amount);
  console.log("Parsed transaction number:", transactionNumber);

  if (!transactionNumber) {
    console.error("Invalid or missing Telebirr transaction number");
    return;
  }

  const verified = await verifyTelebirrReceipt(transactionNumber, "NATNAEL GIRMA", amount);
  console.log("Verification succeeded?", verified);
}

test();
