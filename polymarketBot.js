// Import the pmxt library
import pmxt from 'pmxtjs';

// Initialize the Polymarket client
const polymarket = new pmxt.Polymarket();

// Function to fetch and log market prices
const trackPrices = async () => {
    try {
        console.log('Fetching market data...');

        // Fetch all active markets
        const markets = await polymarket.fetchMarkets({ status: 'active' });

        console.log(`Found ${markets.length} active markets.`);

        // Log prices for each market
        markets.forEach((market) => {
            console.log(`Market: ${market.title}`);
            console.log(`  Yes Price: ${market.yes?.price}`);
            console.log(`  No Price: ${market.no?.price}`);
        });
    } catch (error) {
        console.error('Error fetching market data:', error);
    }
};

// Continuously track prices
const startBot = async () => {
    console.log('Starting Polymarket bot...');

    while (true) {
        await trackPrices();

        // Wait for 5 seconds before fetching again
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
};

startBot().catch(console.error);