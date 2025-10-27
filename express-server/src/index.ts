import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

// ═══════════════════════════════════════════════════════════
// Configuration - X402 Protocol Compliant
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Smart Contract Addresses (Base Mainnet)
const CORE_CONTRACT = '0xC3049467B6c956b84ABEE8c027bbAe6D6B60f29f';
const USDC_CONTRACT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVING_ADDRESS = process.env.RECEIVING_ADDRESS || CORE_CONTRACT;

// CDP API Configuration
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

// Pricing
const TICKET_PRICE_USDC = 5; // 5 USDC per ticket
const TICKET_PRICE_RAW = 5_000000; // 5 USDC (6 decimals)

// Validate credentials
if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.error('⚠️  WARNING: CDP API credentials not configured');
  console.error('   Set CDP_API_KEY_ID and CDP_API_KEY_SECRET');
}

// ═══════════════════════════════════════════════════════════
// Create Express App
// ═══════════════════════════════════════════════════════════

const app = express();

app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Payment', 'Authorization']
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════
// X402 Payment Middleware (Manual Implementation)
// ═══════════════════════════════════════════════════════════

app.use((req, res, next) => {
  if (req.path === '/api/buy-ticket' && req.method === 'POST') {
    const xPayment = req.headers['x-payment'];
    
    if (!xPayment) {
      const ticketCount = parseInt(req.body?.ticketCount || '1');
      const totalCost = TICKET_PRICE_RAW * ticketCount;
      
      return res.status(402)
        .header('X-402-Version', '1')
        .header('X-402-Network', 'base')
        .header('X-402-Asset', USDC_CONTRACT)
        .json({
          x402Version: 1,
          error: 'Payment required',
          message: `Purchase ${ticketCount} mining ticket(s) for ${ticketCount * TICKET_PRICE_USDC} USDC`,
          accepts: [{
            scheme: 'exact',
            network: 'base',
            chainId: 8453,
            maxAmountRequired: totalCost.toString(),
            resource: `${PUBLIC_URL}/api/buy-ticket`,
            description: `Purchase ${ticketCount} mining ticket(s) - ${ticketCount * TICKET_PRICE_USDC} USDC for 6h mining + 24h grace`,
            mimeType: 'application/json',
            payTo: CORE_CONTRACT,
            maxTimeoutSeconds: 300,
            asset: USDC_CONTRACT,
            assetName: 'USDC',
            assetDecimals: 6,
            metadata: {
              serviceName: 'Core Mining Tickets',
              pricePerTicket: `${TICKET_PRICE_USDC} USDC`,
              miningDuration: '6 hours',
              gracePeriod: '24 hours'
            },
            config: {
              inputSchema: {
                type: "object",
                properties: {
                  userAddress: {
                    type: "string",
                    pattern: "^0x[a-fA-F0-9]{40}$",
                    description: "Ethereum address to receive tickets"
                  },
                  ticketCount: {
                    type: "integer",
                    minimum: 1,
                    maximum: 5,
                    description: "Number of tickets (1-5 max)"
                  }
                },
                required: ["userAddress", "ticketCount"]
              },
              outputSchema: {
                type: "object",
                properties: {
                  success: { type: "boolean" },
                  message: { type: "string" },
                  transaction: { type: "string" },
                  ticketIds: { type: "array", items: { type: "number" } },
                  totalCost: { type: "string" }
                }
              }
            }
          }],
          payer: req.body?.userAddress
        });
    }
    
    console.log('✅ X-Payment received');
  }
  
  next();
});

// ═══════════════════════════════════════════════════════════
// API Routes
// ═══════════════════════════════════════════════════════════

app.post('/api/buy-ticket', async (req, res) => {
  try {
    const { userAddress, ticketCount } = req.body;
    const xPayment = req.headers['x-payment'];
    
    console.log('═══════════════════════════════════════');
    console.log('📨 Buy Ticket Request');
    console.log('User:', userAddress);
    console.log('Count:', ticketCount);
    console.log('Has X-Payment:', !!xPayment);
    
    // Validation
    if (!userAddress || !/^0x[a-fA-F0-9]{40}$/i.test(userAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Ethereum address'
      });
    }
    
    const count = parseInt(ticketCount);
    if (!count || count < 1 || count > 5) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket count (1-5)'
      });
    }
    
    // Parse payment data
    let paymentData: any;
    if (xPayment) {
      try {
        paymentData = JSON.parse(String(xPayment));
        console.log('Payment Data:', JSON.stringify(paymentData, null, 2));
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid X-Payment format'
        });
      }
    }
    
    // Call CDP Facilitator API
    console.log('\n🔐 Calling CDP Facilitator...');
    
    const facilitatorUrl = 'https://api.cdp.coinbase.com/platform/v2/x402/settle';
    const authString = Buffer.from(`${CDP_API_KEY_ID}:${CDP_API_KEY_SECRET}`).toString('base64');
    
    const facilitatorResponse = await fetch(facilitatorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${authString}`
      },
      body: JSON.stringify({
        payment: paymentData,
        resource: `${PUBLIC_URL}/api/buy-ticket`,
        contract: {
          address: CORE_CONTRACT,
          function: 'buyTicketsWithAuthorization',
          network: 'base',
          chainId: 8453
        },
        params: {
          user: userAddress,
          count: count
        }
      })
    });
    
    const responseText = await facilitatorResponse.text();
    console.log('Facilitator Status:', facilitatorResponse.status);
    console.log('Response:', responseText.substring(0, 500));
    
    let facilitatorData;
    try {
      facilitatorData = JSON.parse(responseText);
    } catch (e) {
      facilitatorData = { raw: responseText };
    }
    
    if (!facilitatorResponse.ok) {
      console.error('❌ CDP Facilitator error');
      return res.status(502).json({
        success: false,
        error: 'Payment processing failed',
        status: facilitatorResponse.status,
        details: facilitatorData
      });
    }
    
    console.log('✅ Payment successful!');
    console.log('═══════════════════════════════════════');
    
    res.json({
      success: true,
      message: `Successfully purchased ${count} ticket(s)!`,
      transaction: facilitatorData.transaction || facilitatorData.txHash || 'pending',
      ticketIds: Array.from({ length: count }, (_, i) => i + 1),
      userAddress,
      ticketCount: count,
      totalCost: `${count * TICKET_PRICE_USDC} USDC`,
      nextSteps: [
        `✅ ${count} ticket(s) created for ${userAddress}`,
        '⏰ Wait 6+ hours for mining',
        '💎 Claim CORE tokens (6-30h window)',
        '⚠️  Expires after 30 hours'
      ]
    });
    
  } catch (error: any) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ═══════════════════════════════════════════════════════════
// Health & Info Endpoints
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
  const hasCredentials = !!(CDP_API_KEY_ID && CDP_API_KEY_SECRET);
  
  res.json({
    status: 'ok',
    service: 'Core Mining Tickets - X402',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    network: 'Base Mainnet',
    chainId: 8453,
    contract: CORE_CONTRACT,
    usdc: USDC_CONTRACT,
    configuration: {
      cdpConfigured: hasCredentials,
      x402Compliant: true
    }
  });
});

app.get('/', (req, res) => {
  const hasCredentials = !!(CDP_API_KEY_ID && CDP_API_KEY_SECRET);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Core Mining Tickets - X402</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          max-width: 900px;
          margin: 50px auto;
          padding: 30px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .card {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 16px;
          padding: 30px;
          margin: 20px 0;
        }
        h1 { font-size: 2.5em; margin: 0; }
        .status { 
          display: inline-block;
          padding: 5px 15px;
          border-radius: 20px;
          margin: 10px 5px;
          font-weight: bold;
        }
        .ok { background: rgba(34, 197, 94, 0.8); }
        .warn { background: rgba(251, 146, 60, 0.8); }
        a { color: #ffd700; }
        code { 
          background: rgba(0, 0, 0, 0.4);
          padding: 3px 8px;
          border-radius: 4px;
        }
        ul { line-height: 2; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🎫 Core Mining Tickets</h1>
        <p>Gasless USDC Payments via X402 Protocol</p>
        <div class="status ${hasCredentials ? 'ok' : 'warn'}">
          ${hasCredentials ? '✅ X402 Active' : '⚠️ Configure CDP'}
        </div>
      </div>
      
      <div class="card">
        <h2>📊 Service Info</h2>
        <p><strong>Network:</strong> Base Mainnet (8453)</p>
        <p><strong>Contract:</strong> <code>${CORE_CONTRACT}</code></p>
        <p><strong>Price:</strong> 5 USDC per ticket</p>
        <p><strong>Protocol:</strong> X402 v1</p>
      </div>
      
      <div class="card">
        <h2>🔗 Links</h2>
        <ul>
          <li><a href="/health">Health Check</a></li>
          <li><a href="https://www.x402scan.com/recipient/${CORE_CONTRACT.toLowerCase()}/resources">View on X402Scan</a></li>
          <li><a href="https://basescan.org/address/${CORE_CONTRACT}">BaseScan</a></li>
        </ul>
      </div>
      
      <div class="card">
        <h2>🔧 Configuration</h2>
        <p>CDP API Key: ${CDP_API_KEY_ID ? '✅' : '❌'}</p>
        <p>CDP Secret: ${CDP_API_KEY_SECRET ? '✅' : '❌'}</p>
      </div>
    </body>
    </html>
  `);
});

// ═══════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║   🎫 Core Mining Tickets - X402 Protocol                 ║');
  console.log('║                                                           ║');
  console.log(`║   Server:    http://localhost:${PORT.toString().padEnd(32)} ║`);
  console.log('║   Network:   Base Mainnet (8453)                          ║');
  console.log(`║   Contract:  ${CORE_CONTRACT.substring(0, 20)}...   ║`);
  console.log('║                                                           ║');
  console.log('║   ✅ X402 Protocol Implementation                         ║');
  console.log('║   ✅ HTTP 402 Payment Required Ready                      ║');
  console.log('║   ✅ CDP Facilitator Integration                          ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');
  
  if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
    console.log('⚠️  WARNING: CDP credentials not set\n');
  } else {
    console.log('✅ CDP configured - Ready for mainnet\n');
  }
});

export default app;
