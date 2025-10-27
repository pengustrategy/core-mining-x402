// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Core
 * @dev Mining Ticket System - Pay $5 USDC for 6-hour mining machine
 * 
 * Mining Mechanism:
 * - Each ticket = 1 mining machine (6 hours mining)
 * - Users can buy multiple tickets
 * - Output decreases by stages (every 10 billion minted)
 * 
 * Stage Halving:
 * - Stage 1 (0-10B):    300,000 CORE per machine
 * - Stage 2 (10-20B):   150,000 CORE per machine
 * - Stage 3 (20-30B):   75,000 CORE per machine
 * - Stage 4 (30-40B):   37,500 CORE per machine
 * - Stage 5 (40-50B):   18,750 CORE per machine
 * - Stage 6 (50-60B):   9,375 CORE per machine
 * 
 * Features:
 * - Ticket price: 5 USDC
 * - Mining duration: 6 hours
 * - Grace period: 24 hours (can claim 100% output)
 * - Total claim window: 30 hours (6h + 24h)
 * - After 30h: ticket expires
 * - Can buy unlimited tickets
 * - X402 protocol compatible (EIP-3009 gasless payments)
 */

// USDC Interface with EIP-3009 support
interface IUSDC {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    
    // EIP-3009: Transfer with authorization (gasless)
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
    
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

contract Core is ERC20, Ownable, ReentrancyGuard {
    
    // ============ Constants ============
    
    IUSDC public immutable USDC;
    
    // Economic Parameters
    uint256 public constant TICKET_PRICE = 5 * 10**6; // 5 USDC (6 decimals)
    uint256 public constant MAX_TICKETS_PER_ADDRESS = 5; // Max 5 active tickets per address
    
    // Time Parameters
    uint256 public constant MACHINE_LIFETIME = 6 hours; // 6h mining duration
    uint256 public constant CLAIM_GRACE_PERIOD = 24 hours; // 24h grace period after mining
    uint256 public constant TOTAL_CLAIM_WINDOW = 30 hours; // 6h + 24h = 30h total window
    
    // Supply Parameters
    uint256 public constant STAGE_SIZE = 10_000_000_000 * 10**18; // 10 billion per stage
    uint256 public constant MINING_POOL = 60_000_000_000 * 10**18; // 60 billion for mining
    uint256 public constant LP_ALLOCATION = 40_000_000_000 * 10**18; // 40 billion for LP
    uint256 public constant INITIAL_OUTPUT = 300_000 * 10**18; // Stage 1: 300k per machine
    
    // Percentage Constants (for calculations)
    uint256 public constant PERCENTAGE_BASE = 10000; // 100.00% = 10000
    
    // Dynamic emission cap (can be extended by owner)
    uint256 public emissionCap = 100_000_000_000 * 10**18; // 100 billion total (40B LP + 60B mining)
    
    // ============ State Variables ============
    
    uint256 public totalMinted; // Total mined (not including LP tokens)
    uint256 public ticketsSold; // Total tickets sold
    
    struct Machine {
        uint256 ticketId;       // Unique ticket ID
        uint256 purchasedAt;    // Purchase timestamp
        uint256 expiresAt;      // Expiry timestamp (purchasedAt + 12h)
        uint256 output;         // Fixed output for this machine
        bool claimed;           // Has been claimed
    }
    
    // User address => array of their machines
    mapping(address => Machine[]) public userMachines;
    
    // Global ticket ID counter
    uint256 public nextTicketId = 1;
    
    // ============ Events ============
    
    event TicketPurchased(
        address indexed buyer, 
        uint256 indexed ticketId, 
        uint256 output, 
        uint256 stage,
        uint256 expiresAt
    );
    event RewardsClaimed(
        address indexed miner, 
        uint256 indexed ticketId,
        uint256 amount, 
        uint256 timestamp
    );
    event USDCWithdrawn(address indexed owner, uint256 amount);
    event EmissionCapUpdated(uint256 oldCap, uint256 newCap);
    
    // ============ Constructor ============
    
    constructor(address _usdcAddress) ERC20("Core", "CORE") Ownable(msg.sender) {
        USDC = IUSDC(_usdcAddress);
        // On-demand minting when claimed
        // 40 billion for LP should be minted separately by owner if needed
    }
    
    // ============ Core Functions ============
    
    /**
     * @dev Purchase mining tickets (can buy multiple)
     * @param count Number of tickets to purchase (1-5 based on current active tickets)
     * 
     * Process:
     * 1. Check active ticket limit (max 5 per address)
     * 2. Transfer USDC (count × 5 USDC)
     * 3. Lock current stage output (all tickets in same purchase get same output)
     * 4. Create Machine records
     * 5. Emit events
     * 
     * Time Window:
     * - 0-6h: Mining (can claim proportional)
     * - 6h-30h: Grace period (can claim 100%)
     * - 30h+: Expired (cannot claim)
     */
    function buyTickets(uint256 count) external nonReentrant {
        require(count > 0, "Invalid count");
        require(totalMinted < MINING_POOL, "Mining pool depleted");
        
        // Check active tickets limit (max 5 active tickets per address)
        uint256 activeTickets = getActiveTicketCount(msg.sender);
        require(activeTickets + count <= MAX_TICKETS_PER_ADDRESS, "Exceeds max tickets per address");
        
        uint256 totalCost = TICKET_PRICE * count;
        
        // Transfer USDC from user
        require(
            USDC.transferFrom(msg.sender, address(this), totalCost),
            "USDC transfer failed"
        );
        
        // ⚡ OPTIMIZATION: Calculate stage ONCE for entire purchase
        // All tickets in this transaction get same output (locked at purchase time)
        uint256 currentStage = getCurrentStage();
        uint256 outputPerMachine = calculateStageOutput(currentStage);
        uint256 purchaseTime = block.timestamp;
        uint256 expiryTime = purchaseTime + MACHINE_LIFETIME; // 6h from now
        
        // Create machines for user
        for (uint256 i = 0; i < count; i++) {
            Machine memory machine = Machine({
                ticketId: nextTicketId,
                purchasedAt: purchaseTime,
                expiresAt: expiryTime,
                output: outputPerMachine, // Locked at purchase
                claimed: false
            });
            
            userMachines[msg.sender].push(machine);
            
            emit TicketPurchased(
                msg.sender,
                nextTicketId,
                outputPerMachine,
                currentStage,
                expiryTime
            );
            
            nextTicketId++;
        }
        
        ticketsSold += count;
    }
    
    /**
     * @dev Purchase mining tickets for another user (X402 server use)
     * @param user The address to create tickets for
     * @param count Number of tickets to purchase
     * 
     * X402 Integration:
     * - X402 server calls this function
     * - Server pays USDC and gas
     * - Tickets created for actual user (not server)
     * - User gets gasless purchase experience
     * 
     * Process:
     * 1. Check user's active ticket limit (not caller's)
     * 2. Caller (server) transfers USDC
     * 3. Create tickets for user
     * 4. User can claim with their wallet or via claimFor()
     */
    function buyTicketsFor(address user, uint256 count) external nonReentrant {
        require(user != address(0), "Invalid user address");
        require(count > 0, "Invalid count");
        require(totalMinted < MINING_POOL, "Mining pool depleted");
        
        // Check user's active tickets limit (not msg.sender's!)
        uint256 activeTickets = getActiveTicketCount(user);
        require(activeTickets + count <= MAX_TICKETS_PER_ADDRESS, "User exceeds max tickets");
        
        uint256 totalCost = TICKET_PRICE * count;
        
        // Transfer USDC from caller (server) to contract
        require(
            USDC.transferFrom(msg.sender, address(this), totalCost),
            "USDC transfer failed"
        );
        
        // ⚡ OPTIMIZATION: Calculate stage ONCE for entire purchase
        uint256 currentStage = getCurrentStage();
        uint256 outputPerMachine = calculateStageOutput(currentStage);
        uint256 purchaseTime = block.timestamp;
        uint256 expiryTime = purchaseTime + MACHINE_LIFETIME;
        
        // Create machines for USER (not msg.sender!)
        for (uint256 i = 0; i < count; i++) {
            Machine memory machine = Machine({
                ticketId: nextTicketId,
                purchasedAt: purchaseTime,
                expiresAt: expiryTime,
                output: outputPerMachine,
                claimed: false
            });
            
            userMachines[user].push(machine); // Store in user's account
            
            emit TicketPurchased(
                user, // User receives tickets, not caller
                nextTicketId,
                outputPerMachine,
                currentStage,
                expiryTime
            );
            
            nextTicketId++;
        }
        
        ticketsSold += count;
    }
    
    /**
     * @dev Purchase mining tickets using EIP-3009 gasless authorization (X402 compatible)
     * @param user The address to create tickets for
     * @param count Number of tickets to purchase
     * @param from Authorizer address (should equal user)
     * @param value USDC amount (should equal TICKET_PRICE × count)
     * @param validAfter Timestamp after which authorization is valid
     * @param validBefore Timestamp before which authorization is valid
     * @param nonce Unique nonce for this authorization
     * @param v ECDSA signature parameter
     * @param r ECDSA signature parameter
     * @param s ECDSA signature parameter
     * 
     * X402 Protocol Integration:
     * - User signs EIP-3009 authorization off-chain (via 402scan or wallet)
     * - Facilitator or server calls this function on-chain (pays gas)
     * - USDC transferred directly from user to contract (gasless for user)
     * - Tickets created for user
     * - User only signs once, no additional wallet interaction needed
     * 
     * Like PING token's "HTTP-native fair launch":
     * - Simple web request → Sign authorization → Instant on-chain settlement
     * - No gas fees for user, no approve() needed
     * - "Inscription-like" experience through HTTP 402
     * 
     * Security:
     * - USDC contract validates signature and nonce (prevents replay)
     * - Authorization must be to this contract
     * - Amount must match ticket price × count
     * - All standard checks (active ticket limit, mining pool) enforced
     */
    function buyTicketsWithAuthorization(
        address user,
        uint256 count,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        require(user != address(0), "Invalid user address");
        require(user == from, "User must be authorizer");
        require(count > 0, "Invalid count");
        require(totalMinted < MINING_POOL, "Mining pool depleted");
        
        // Check user's active tickets limit
        uint256 activeTickets = getActiveTicketCount(user);
        require(activeTickets + count <= MAX_TICKETS_PER_ADDRESS, "User exceeds max tickets");
        
        // Verify authorization amount matches ticket cost
        uint256 totalCost = TICKET_PRICE * count;
        require(value == totalCost, "Incorrect authorization amount");
        
        // ⚡ EIP-3009: Execute gasless USDC transfer
        // This call validates signature, nonce, and executes transfer
        // User pays 0 gas - caller (facilitator/server) pays gas
        // USDC moves from user → contract atomically
        USDC.transferWithAuthorization(
            from,              // User's address (authorizer)
            address(this),     // Contract receives USDC
            value,             // Must equal totalCost
            validAfter,        // Timestamp constraints
            validBefore,
            nonce,             // Prevents replay attacks
            v, r, s            // User's signature
        );
        
        // ⚡ OPTIMIZATION: Calculate stage ONCE for entire purchase
        // All tickets in this transaction get same output (locked at purchase time)
        uint256 currentStage = getCurrentStage();
        uint256 outputPerMachine = calculateStageOutput(currentStage);
        uint256 purchaseTime = block.timestamp;
        uint256 expiryTime = purchaseTime + MACHINE_LIFETIME;
        
        // Create machines for USER
        for (uint256 i = 0; i < count; i++) {
            Machine memory machine = Machine({
                ticketId: nextTicketId,
                purchasedAt: purchaseTime,
                expiresAt: expiryTime,
                output: outputPerMachine,
                claimed: false
            });
            
            userMachines[user].push(machine);
            
            emit TicketPurchased(
                user,
                nextTicketId,
                outputPerMachine,
                currentStage,
                expiryTime
            );
            
            nextTicketId++;
        }
        
        ticketsSold += count;
    }
    
    /**
     * @dev Claim rewards from machines
     * @param ticketIds Array of ticket IDs to claim
     * 
     * Claiming Rules:
     * - Must be within 30h window (6h mining + 24h grace)
     * - 0-6h: Proportional output (time/6h × 100%)
     * - 6h-30h: Full output (100%)
     * - 30h+: Expired (0%, cannot claim)
     * 
     * Gas Optimization:
     * - Can batch claim multiple tickets
     * - Recommended: Claim after 6h for max output
     * 
     * Note: Claims rewards for msg.sender (caller's own tickets)
     */
    function claim(uint256[] calldata ticketIds) external nonReentrant {
        uint256 totalRewards = 0;
        
        for (uint256 i = 0; i < ticketIds.length; i++) {
            uint256 ticketId = ticketIds[i];
            
            // Find the machine in caller's machines
            Machine[] storage machines = userMachines[msg.sender];
            bool found = false;
            
            for (uint256 j = 0; j < machines.length; j++) {
                if (machines[j].ticketId == ticketId && !machines[j].claimed) {
                    Machine storage machine = machines[j];
                    
                    // Calculate claim deadline (6h mining + 24h grace = 30h total)
                    uint256 claimDeadline = machine.purchasedAt + TOTAL_CLAIM_WINDOW;
                    
                    // Check claim window (must be within 30h from purchase)
                    require(block.timestamp >= machine.purchasedAt, "Mining not started");
                    require(block.timestamp <= claimDeadline, "Claim period expired (30h limit)");
                    
                    // Mark as claimed
                    machine.claimed = true;
                    
                    // Calculate output based on elapsed time
                    uint256 elapsed = block.timestamp - machine.purchasedAt;
                    uint256 actualOutput;
                    
                    if (elapsed >= MACHINE_LIFETIME) {
                        // Machine finished (6h+), in grace period (6h-30h) - give 100% output
                        actualOutput = machine.output;
                    } else {
                        // Machine still mining (0-6h) - give proportional output
                        // timeRatio = (elapsed / 6h) × 100%
                        uint256 timeRatio = (elapsed * PERCENTAGE_BASE) / MACHINE_LIFETIME;
                        actualOutput = (machine.output * timeRatio) / PERCENTAGE_BASE;
                    }
                    
                    totalRewards += actualOutput;
                    found = true;
                    
                    emit RewardsClaimed(msg.sender, ticketId, actualOutput, block.timestamp);
                    break;
                }
            }
            
            require(found, "Ticket not found or already claimed");
        }
        
        require(totalRewards > 0, "No rewards to claim");
        require(totalMinted + totalRewards <= MINING_POOL, "Exceeds mining pool");
        
        // Update total minted
        totalMinted += totalRewards;
        
        // Mint tokens to user
        _mint(msg.sender, totalRewards);
    }
    
    /**
     * @dev Claim rewards on behalf of a user (X402 server use)
     * @param user The address to claim for
     * @param ticketIds Array of ticket IDs to claim
     * 
     * X402 Integration:
     * - X402 server can call this function
     * - Server pays gas (gasless for user)
     * - Tokens minted to actual user, not server
     * 
     * Security:
     * - Only claims tickets owned by 'user'
     * - Cannot claim tickets of other addresses
     * - Same validation as regular claim()
     */
    function claimFor(address user, uint256[] calldata ticketIds) external nonReentrant {
        require(user != address(0), "Invalid user address");
        
        uint256 totalRewards = 0;
        
        for (uint256 i = 0; i < ticketIds.length; i++) {
            uint256 ticketId = ticketIds[i];
            
            // Find the machine in user's machines (not msg.sender's)
            Machine[] storage machines = userMachines[user];
            bool found = false;
            
            for (uint256 j = 0; j < machines.length; j++) {
                if (machines[j].ticketId == ticketId && !machines[j].claimed) {
                    Machine storage machine = machines[j];
                    
                    // Calculate claim deadline (6h mining + 24h grace = 30h total)
                    uint256 claimDeadline = machine.purchasedAt + TOTAL_CLAIM_WINDOW;
                    
                    // Check claim window (must be within 30h from purchase)
                    require(block.timestamp >= machine.purchasedAt, "Mining not started");
                    require(block.timestamp <= claimDeadline, "Claim period expired (30h limit)");
                    
                    // Mark as claimed
                    machine.claimed = true;
                    
                    // Calculate output based on elapsed time
                    uint256 elapsed = block.timestamp - machine.purchasedAt;
                    uint256 actualOutput;
                    
                    if (elapsed >= MACHINE_LIFETIME) {
                        // Machine finished (6h+), in grace period (6h-30h) - give 100% output
                        actualOutput = machine.output;
                    } else {
                        // Machine still mining (0-6h) - give proportional output
                        uint256 timeRatio = (elapsed * PERCENTAGE_BASE) / MACHINE_LIFETIME;
                        actualOutput = (machine.output * timeRatio) / PERCENTAGE_BASE;
                    }
                    
                    totalRewards += actualOutput;
                    found = true;
                    
                    emit RewardsClaimed(user, ticketId, actualOutput, block.timestamp);
                    break;
                }
            }
            
            require(found, "Ticket not found or already claimed");
        }
        
        require(totalRewards > 0, "No rewards to claim");
        require(totalMinted + totalRewards <= MINING_POOL, "Exceeds mining pool");
        
        // Update total minted
        totalMinted += totalRewards;
        
        // Mint tokens to USER (not msg.sender!)
        _mint(user, totalRewards);
    }
    
    /**
     * @dev Get current mining stage (0-5 for 6 stages)
     */
    function getCurrentStage() public view returns (uint256) {
        uint256 stage = totalMinted / STAGE_SIZE;
        return stage >= 6 ? 5 : stage; // Cap at stage 5
    }
    
    /**
     * @dev Count active (unclaimed and not expired) tickets for an address
     * 
     * Active Definition:
     * - Not claimed AND
     * - Within 30h window (6h mining + 24h grace)
     * 
     * Used to enforce MAX_TICKETS_PER_ADDRESS limit
     */
    function getActiveTicketCount(address user) public view returns (uint256) {
        Machine[] storage machines = userMachines[user];
        uint256 activeCount = 0;
        uint256 currentTime = block.timestamp;
        
        for (uint256 i = 0; i < machines.length; i++) {
            Machine storage machine = machines[i];
            uint256 claimDeadline = machine.purchasedAt + TOTAL_CLAIM_WINDOW; // 30h window
            
            // Count as active if not claimed and not expired (within 30h)
            if (!machine.claimed && currentTime <= claimDeadline) {
                activeCount++;
            }
        }
        
        return activeCount;
    }
    
    /**
     * @dev Calculate output per machine for a given stage
     * Stage 0: 300,000
     * Stage 1: 150,000
     * Stage 2: 75,000
     * etc. (halving each stage)
     */
    function calculateStageOutput(uint256 stage) public pure returns (uint256) {
        if (stage >= 6) return 0; // No more mining after 60B
        
        uint256 output = INITIAL_OUTPUT;
        for (uint256 i = 0; i < stage; i++) {
            output = output / 2;
        }
        return output;
    }
    
    /**
     * @dev Get user's machines info
     * 
     * Returns comprehensive data for all user's machines:
     * - Ticket IDs
     * - Purchase timestamps
     * - Expiry timestamps (purchasedAt + 6h)
     * - Fixed outputs (locked at purchase)
     * - Claimed status
     * - Current claimable amounts (calculated in real-time)
     * 
     * Claimable Calculation:
     * - 0-6h: Proportional (elapsed/6h × output)
     * - 6h-30h: 100% output
     * - 30h+: 0 (expired)
     */
    function getUserMachines(address user) external view returns (
        uint256[] memory ticketIds,
        uint256[] memory purchasedAts,
        uint256[] memory expiresAts,
        uint256[] memory outputs,
        bool[] memory claimeds,
        uint256[] memory claimableNow
    ) {
        Machine[] storage machines = userMachines[user];
        uint256 count = machines.length;
        
        ticketIds = new uint256[](count);
        purchasedAts = new uint256[](count);
        expiresAts = new uint256[](count);
        outputs = new uint256[](count);
        claimeds = new bool[](count);
        claimableNow = new uint256[](count);
        
        for (uint256 i = 0; i < count; i++) {
            Machine memory machine = machines[i];
            ticketIds[i] = machine.ticketId;
            purchasedAts[i] = machine.purchasedAt;
            expiresAts[i] = machine.expiresAt;
            outputs[i] = machine.output;
            claimeds[i] = machine.claimed;
            
            // Calculate claimable amount now
            uint256 claimDeadline = machine.purchasedAt + TOTAL_CLAIM_WINDOW; // 30h total window
            
            if (!machine.claimed && block.timestamp >= machine.purchasedAt && block.timestamp <= claimDeadline) {
                uint256 elapsed = block.timestamp - machine.purchasedAt;
                
                if (elapsed >= MACHINE_LIFETIME) {
                    // Machine finished (6h+), in grace period (6h-30h) - 100% claimable
                    claimableNow[i] = machine.output;
                } else {
                    // Machine still mining (0-6h) - proportional output
                    uint256 timeRatio = (elapsed * PERCENTAGE_BASE) / MACHINE_LIFETIME;
                    claimableNow[i] = (machine.output * timeRatio) / PERCENTAGE_BASE;
                }
            } else {
                // Not started yet or expired (30h+)
                claimableNow[i] = 0;
            }
        }
        
        return (ticketIds, purchasedAts, expiresAts, outputs, claimeds, claimableNow);
    }
    
    /**
     * @dev Get platform-wide statistics
     * 
     * Returns:
     * - currentStage: Current mining stage (0-5)
     * - stageOutput: Output per machine in current stage
     * - totalMintedAmount: Total CORE minted from mining (not including LP)
     * - remainingInPool: Remaining in 60B mining pool
     * - ticketsSoldCount: Total tickets sold
     * - currentEmissionCap: Current emission limit (can be extended)
     */
    function getPlatformStats() external view returns (
        uint256 currentStage,
        uint256 stageOutput,
        uint256 totalMintedAmount,
        uint256 remainingInPool,
        uint256 ticketsSoldCount,
        uint256 currentEmissionCap
    ) {
        uint256 stage = getCurrentStage();
        return (
            stage,
            calculateStageOutput(stage),
            totalMinted,
            MINING_POOL - totalMinted,
            ticketsSold,
            emissionCap
        );
    }
    
    // ============ Owner Functions ============
    
    /**
     * @dev Withdraw accumulated USDC (owner only)
     */
    function withdrawUSDC() external onlyOwner {
        uint256 balance = USDC.balanceOf(address(this));
        require(balance > 0, "No USDC");
        require(USDC.transfer(owner(), balance), "Transfer failed");
        emit USDCWithdrawn(owner(), balance);
    }
    
    /**
     * @dev Update emission cap for sustainability (hidden extension)
     */
    function updateEmissionCap(uint256 newCap) external onlyOwner {
        require(newCap >= totalMinted, "Below minted");
        require(newCap <= 1_000_000_000_000 * 10**18, "Exceeds hard limit");
        uint256 oldCap = emissionCap;
        emissionCap = newCap;
        emit EmissionCapUpdated(oldCap, newCap);
    }
    
    /**
     * @dev Mint LP tokens (owner only, one-time for initial liquidity)
     * 
     * Requirements:
     * - Can only be called once (when totalSupply = 0)
     * - Maximum 40 billion CORE
     * - Tokens minted to owner for LP setup
     * 
     * Usage:
     * 1. Deploy contract
     * 2. Call mintForLP(40000000000000000000000000000) // 40B
     * 3. Add liquidity on DEX (40B CORE + $10k USDT)
     */
    function mintForLP(uint256 amount) external onlyOwner {
        require(totalSupply() == 0, "LP already minted");
        require(amount <= LP_ALLOCATION, "Exceeds LP allocation (40B max)");
        _mint(owner(), amount);
    }
}
