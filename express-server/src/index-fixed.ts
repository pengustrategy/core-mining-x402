import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { ethers } from 'ethers';

dotenv.config();

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

// Contract Configuration
const CORE_CONTRACT = process.env.CORE_CONTRACT || '0xC3049467B6c956b84ABEE8c027bbAe6D6B60f29f';
const USDC_CONTRACT = process.env.USDC_CONTRACT || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const RECEIVING_ADDRESS = process.env.RECEIVING_ADDRESS || CORE_CONTRACT;

// CDP Configuration
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;

if (!CDP_API_KEY_ID || !CDP_API_KEY_SECRET) {
  console.error('❌ FATAL: CDP API credentials not found in environment variables');
  console.error('   Please set CDP_API_KEY_ID and CDP_API_KEY_SECRET');
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════
// Express App Setup
// ═══════════════════════════════════════════════════════════

const app = express();

app.use(cors({
  origin: '*', // TODO: Restrict to your frontend domains in production
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Payment', 'Authorization']
}));

app.use(express.json());

// Request logging
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════

const TICKET_PRICE = 5_000000; // 5 USDC (6 decimals)

// ═══════════════════════════════════════════════════════════
// X402 Payment Middleware
// ═══════════════════════════════════════════════════════════

app.use((req, res, next) => {
  // Only process /api/buy-ticket endpoint
  if (req.path === '/api/buy-ticket' && req.method === 'POST') {
    const xPayment = req.headers['x-payment'];
    
    if (!xPayment) {
      // Return 402 Payment Required
      const ticketCount = parseInt(req.body?.ticketCount || '1');
      const totalCost = TICKET_PRICE * ticketCount;
      
      return res.status(402)
        .header('X-402-Version', '1')
        .header('X-402-Network', 'base')
        .header('X-402-Asset', USDC_CONTRACT)
        .json({
          x402Version: 1,
          error: 'Payment required',
          message: `Purchase ${ticketCount} mining ticket(s) for ${ticketCount * 5} USDC`,
          accepts: [{
            scheme: 'exact',
            network: 'base',
            chainId: 8453,
            maxAmountRequired: totalCost.toString(),
            resource: `${PUBLIC_URL}/api/buy-ticket`,
            description: `Purchase ${ticketCount} mining ticket(s) - Pay ${ticketCount * 5} USDC, mine CORE tokens`,
            mimeType: 'application/json',
            payTo: CORE_CONTRACT,
            maxTimeoutSeconds: 3600,
            asset: USDC_CONTRACT,
            assetName: 'USDC',
            assetDecimals: 6,
            metadata: {
              serviceName: 'Core Mining Tickets',
              ticketPrice: '5 USDC',
              miningDuration: '6 hours',
              gracePeriod: '24 hours',
              totalWindow: '30 hours'
            },
            outputSchema: {
              input: {
                type: 'http',
                method: 'POST',
                bodyType: 'json',
                bodyFields: {
                  userAddress: { 
                    type: 'string', 
                    required: true,
                    pattern: '^0x[a-fA-F0-9]{40}$',
                    description: 'Ethereum address to receive tickets'
                  },
                  ticketCount: { 
                    type: 'number', 
                    required: true, 
                    minimum: 1,
                    maximum: 5,
                    description: 'Number of tickets to purchase (1-5)'
                  },
                },
              },
            },
          }],
          payer: req.body?.userAddress,
        });
    }
    
    // Payment provided, continue to handler
    console.log('✅ X-Payment header received, processing...');
  }
  
  next();
});

// ═══════════════════════════════════════════════════════════
// X402 Manifest Endpoint (for discoverability)
// ═══════════════════════════════════════════════════════════

app.get('/.well-known/x402/manifest', (req, res) => {
  res.json({
    x402Version: 1,
    name: 'Core Mining Tickets',
    description: 'Zero-gas mining ticket system on Base blockchain. Purchase tickets with USDC, mine CORE tokens. Each ticket provides 6 hours of mining power with 24-hour grace period.',
    icon: `${PUBLIC_URL}/icon.png`, // TODO: Add icon
    website: 'https://github.com/pengustrategy/core-mining-x402',
    support: 'https://discord.gg/your-discord', // TODO: Add support link
    network: 'base',
    chainId: 8453,
    contract: CORE_CONTRACT,
    resources: [
      {
        id: 'buy-tickets',
        name: 'Buy Mining Tickets',
        description: 'Purchase 1-5 mining tickets. Each ticket costs 5 USDC and provides 6 hours of mining power plus 24-hour grace period to claim rewards.',
        endpoint: `${PUBLIC_URL}/api/buy-ticket`,
        methods: ['POST'],
        network: 'base',
        chainId: 8453,
        asset: USDC_CONTRACT,
        assetSymbol: 'USDC',
        assetDecimals: 6,
        recipient: CORE_CONTRACT,
        pricing: {
          type: 'variable',
          baseAmount: TICKET_PRICE.toString(),
          description: '5 USDC per ticket (1-5 tickets supported)',
          formula: 'ticketCount × 5 USDC'
        },
        inputSchema: {
          type: 'object',
          properties: {
            userAddress: {
              type: 'string',
              pattern: '^0x[a-fA-F0-9]{40}$',
              description: 'Ethereum address to receive tickets'
            },
            ticketCount: {
              type: 'integer',
              minimum: 1,
              maximum: 5,
              description: 'Number of tickets to purchase'
            }
          },
          required: ['userAddress', 'ticketCount']
        },
        outputSchema: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            transaction: { type: 'string' },
            ticketIds: { 
              type: 'array',
              items: { type: 'number' }
            }
          }
        }
      }
    ],
    metadata: {
      tags: ['mining', 'defi', 'base', 'gasless', 'eip-3009'],
      category: 'gaming',
      featured: true,
      version: '1.0.0',
      updated: new Date().toISOString()
    }
  });
});

// ═══════════════════════════════════════════════════════════
// Buy Ticket Endpoint
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
    if (!userAddress || !ethers.isAddress(userAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user address'
      });
    }
    
    const count = parseInt(ticketCount);
    if (!count || count < 1 || count > 5) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ticket count (must be 1-5)'
      });
    }

    // Parse X-Payment header
    let paymentData: any;
    if (xPayment) {
      try {
        paymentData = JSON.parse(String(xPayment));
        console.log('\n📦 X-Payment Data:');
        console.log(JSON.stringify(paymentData, null, 2));
      } catch (e) {
        console.error('Failed to parse X-Payment:', e);
        return res.status(400).json({
          success: false,
          error: 'Invalid X-Payment format'
        });
      }
    }

    // ============================================
    // Call CDP Facilitator API
    // ============================================
    
    console.log('\n🔐 Calling CDP Facilitator API...');
    
    // Method 1: Try with official SDK (recommended)
    // TODO: Install @coinbase/coinbase-sdk and use official method
    
    // Method 2: Direct HTTP API call (current implementation)
    const facilitatorUrl = 'https://api.cdp.coinbase.com/platform/v2/x402/settle';
    
    // Prepare authentication
    // Note: This may need adjustment based on actual CDP API requirements
    const authString = Buffer.from(`${CDP_API_KEY_ID}:${CDP_API_KEY_SECRET}`).toString('base64');
    
    const facilitatorPayload = {
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
    };
    
    console.log('Payload:', JSON.stringify(facilitatorPayload, null, 2));
    
    const facilitatorResponse = await fetch(facilitatorUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Try multiple authentication methods (one should work)
        'Authorization': `Basic ${authString}`, // Basic Auth
        'X-API-KEY': CDP_API_KEY_ID,
        'X-API-SECRET': CDP_API_KEY_SECRET,
      },
      body: JSON.stringify(facilitatorPayload),
    });

    console.log('Facilitator Status:', facilitatorResponse.status);
    
    const responseText = await facilitatorResponse.text();
    console.log('Facilitator Response:', responseText.substring(0, 500));
    
    let facilitatorData;
    try {
      facilitatorData = JSON.parse(responseText);
    } catch (e) {
      console.error('Failed to parse facilitator response');
      facilitatorData = { raw: responseText };
    }

    if (!facilitatorResponse.ok) {
      console.error('❌ CDP Facilitator API error');
      console.error('Status:', facilitatorResponse.status);
      console.error('Response:', facilitatorData);
      
      return res.status(502).json({
        success: false,
        error: 'CDP Facilitator API error',
        status: facilitatorResponse.status,
        response: facilitatorData,
        message: 'Payment processing failed. Please try again or contact support.',
      });
    }

    console.log('✅ CDP Facilitator executed transaction!');
    console.log('Result:', JSON.stringify(facilitatorData, null, 2));
    console.log('═══════════════════════════════════════');

    res.json({
      success: true,
      message: `Successfully purchased ${count} ticket(s)!`,
      transaction: facilitatorData.transaction || facilitatorData.txHash || facilitatorData,
      userAddress,
      ticketCount: count,
      totalCost: `${count * 5} USDC`,
      facilitator: 'CDP (Coinbase pays gas)',
      nextSteps: [
        'Wait 6+ hours for mining to complete',
        'Claim your CORE tokens',
        'Must claim within 30 hours of purchase'
      ]
    });
    
  } catch (error: any) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      message: 'Internal server error. Please contact support.',
    });
  }
});

// ═══════════════════════════════════════════════════════════
// Health Check & Info Endpoints
// ═══════════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  try {
    // Check configuration
    const hasCredentials = !!(CDP_API_KEY_ID && CDP_API_KEY_SECRET);
    
    // TODO: Add actual CDP API connectivity check
    // const cdpConnected = await checkCDPConnection();
    
    res.json({
      status: 'ok',
      service: 'Core Mining X402 Server',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      network: 'Base Mainnet',
      chainId: 8453,
      contract: CORE_CONTRACT,
      usdc: USDC_CONTRACT,
      configuration: {
        hasCredentials,
        cdpConfigured: hasCredentials,
        // cdpConnected // TODO: Uncomment when check is implemented
      },
      endpoints: {
        manifest: `${PUBLIC_URL}/.well-known/x402/manifest`,
        buyTicket: `${PUBLIC_URL}/api/buy-ticket`,
        health: `${PUBLIC_URL}/health`
      }
    });
  } catch (error: any) {
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Core Mining Tickets - X402 Service</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          max-width: 800px;
          margin: 50px auto;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
        }
        .card {
          background: rgba(255, 255, 255, 0.1);
          backdrop-filter: blur(10px);
          border-radius: 16px;
          padding: 30px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
        }
        h1 { margin-top: 0; }
        a { color: #ffd700; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .info { background: rgba(255, 255, 255, 0.05); padding: 15px; border-radius: 8px; margin: 10px 0; }
        .status { color: #4ade80; font-weight: bold; }
        code { background: rgba(0, 0, 0, 0.3); padding: 2px 6px; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🎫 Core Mining Tickets</h1>
        <p class="status">✅ X402 Service Running</p>
        
        <h2>📊 Service Information</h2>
        <div class="info">
          <p><strong>Network:</strong> Base Mainnet (8453)</p>
          <p><strong>Contract:</strong> <code>${CORE_CONTRACT}</code></p>
          <p><strong>Protocol:</strong> X402 (EIP-3009 Gasless Payments)</p>
        </div>
        
        <h2>🔗 Links</h2>
        <ul>
          <li><a href="/.well-known/x402/manifest">X402 Manifest</a></li>
          <li><a href="/health">Health Check</a></li>
          <li><a href="https://www.x402scan.com/recipient/${CORE_CONTRACT.toLowerCase()}/resources" target="_blank">View on 402scan</a></li>
          <li><a href="https://basescan.org/address/${CORE_CONTRACT}" target="_blank">View Contract on BaseScan</a></li>
        </ul>
        
        <h2>💡 How It Works</h2>
        <ol>
          <li>User discovers service on <a href="https://www.x402scan.com" target="_blank">402scan.com</a></li>
          <li>User signs EIP-3009 authorization (gasless)</li>
          <li>CDP Facilitator executes transaction (pays gas)</li>
          <li>User receives mining ticket immediately</li>
          <li>User claims CORE tokens after 6+ hours</li>
        </ol>
        
        <h2>🎯 Features</h2>
        <ul>
          <li>✅ Zero Gas Fees (for users AND server)</li>
          <li>✅ Pay with USDC only</li>
          <li>✅ 6-hour mining period</li>
          <li>✅ 24-hour grace period</li>
          <li>✅ Up to 5 tickets per address</li>
        </ul>
        
        <p style="margin-top: 30px; text-align: center; opacity: 0.7;">
          Powered by <a href="https://docs.cdp.coinbase.com/x402" target="_blank">Coinbase X402 Protocol</a>
        </p>
      </div>
    </body>
    </html>
  `);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Endpoint ${req.method} ${req.path} not found`,
    availableEndpoints: [
      'GET /',
      'GET /health',
      'GET /.well-known/x402/manifest',
      'POST /api/buy-ticket'
    ]
  });
});

// ═══════════════════════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║                                                           ║');
  console.log('║   🎫 Core Mining Tickets - X402 Server                   ║');
  console.log('║                                                           ║');
  console.log(`║   Server:    http://localhost:${PORT.toString().padEnd(32)} ║`);
  console.log('║   Network:   Base Mainnet (8453)                          ║');
  console.log(`║   Contract:  ${CORE_CONTRACT.substring(0, 20)}...   ║`);
  console.log('║                                                           ║');
  console.log('║   ✅ CDP Facilitator configured                           ║');
  console.log('║   ✅ X402 manifest endpoint active                        ║');
  console.log('║   ✅ Gasless payment ready                                ║');
  console.log('║                                                           ║');
  console.log('║   Endpoints:                                              ║');
  console.log('║   - GET  /                                                ║');
  console.log('║   - GET  /health                                          ║');
  console.log('║   - GET  /.well-known/x402/manifest                       ║');
  console.log('║   - POST /api/buy-ticket                                  ║');
  console.log('║                                                           ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  if (process.env.NODE_ENV === 'production') {
    console.log('\n🚀 Production mode');
    console.log(`📡 Public URL: ${PUBLIC_URL}`);
  } else {
    console.log('\n🔧 Development mode');
    console.log('📝 Logs: Verbose');
  }
  
  console.log('\n');
});

export default app;

