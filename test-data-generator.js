// test-data-generator.js
// Run this script to generate test data for Stitch Outfitters
// Usage: node test-data-generator.js

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  TOTAL_CLIENTS: 100000,
  ORDERS_PER_CLIENT: 10,
  PENDING_COUNT: 5000,      // total pending orders across all clients
  OVERDUE_COUNT: 800,       // total overdue orders
  UNPAID_COUNT: 2000,        // total unpaid/partial orders
};

// Helper Functions
function randomDate(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  return new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function randomPhone() {
  const prefixes = ['0300', '0301', '0302', '0303', '0304', '0310', '0311', '0312', '0313', '0320', '0321', '0322', '0330', '0331', '0332', '0333', '0340', '0341', '0342', '0343', '0344', '0345', '0346', '0347', '0348', '0349', '0350'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = Math.floor(Math.random() * 10000000).toString().padStart(7, '0');
  return `+92 ${prefix} ${number.slice(0, 4)} ${number.slice(4)}`;
}

function randomName() {
  const firstNames = ['Ahmed', 'Ali', 'Asif', 'Bilal', 'Danish', 'Farhan', 'Hamza', 'Hassan', 'Imran', 'Junaid', 'Kashif', 'Khurram', 'Majid', 'Nabeel', 'Noman', 'Omar', 'Rizwan', 'Saad', 'Saeed', 'Salman', 'Shahid', 'Tahir', 'Umar', 'Waqas', 'Wasim', 'Yasir', 'Zahid', 'Zeeshan', 'Ayesha', 'Fatima', 'Hina', 'Iqra', 'Kiran', 'Maria', 'Mehwish', 'Nadia', 'Rabia', 'Sadia', 'Sana', 'Sara', 'Zara'];
  const lastNames = ['Khan', 'Malik', 'Butt', 'Chaudhry', 'Sheikh', 'Rana', 'Hashmi', 'Siddiqui', 'Qureshi', 'Awan', 'Gill', 'Jutt', 'Gujjar', 'Syed', 'Abbasi', 'Naqvi', 'Zahid', 'Mahmood', 'Iqbal', 'Akhtar', 'Hussain', 'Ahmed', 'Ali', 'Hasan', 'Rizvi', 'Zaidi', 'Usmani', 'Farooqi'];
  return `${firstNames[Math.floor(Math.random() * firstNames.length)]} ${lastNames[Math.floor(Math.random() * lastNames.length)]}`;
}

function randomEmail(name) {
  const domains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'example.com', 'tailor.pk', 'stitch.com'];
  const cleanName = name.toLowerCase().replace(/\s/g, '.');
  return `${cleanName}${Math.floor(Math.random() * 100000)}@${domains[Math.floor(Math.random() * domains.length)]}`;
}

function randomCity() {
  const cities = ['Lahore', 'Karachi', 'Islamabad', 'Rawalpindi', 'Multan', 'Faisalabad', 'Peshawar', 'Quetta', 'Sialkot', 'Gujranwala', 'Hyderabad', 'Sukkur', 'Bahawalpur', 'Sargodha', 'Jhelum', 'Mianwali', 'Abbottabad', 'Murree', 'Gujrat', 'Sheikhupura'];
  return cities[Math.floor(Math.random() * cities.length)];
}

function randomAddress(city) {
  const streets = ['Main Boulevard', 'Gulberg', 'Defence', 'Cantt', 'Johar Town', 'Bahria Town', 'DHA', 'Saddar', 'F-7', 'F-8', 'G-10', 'I-8', 'E-11', 'PECHS', 'Clifton', 'Garden Town', 'Model Town', 'Township', 'Valencia', 'Wapda Town'];
  return `${Math.floor(Math.random() * 99999) + 1}, ${streets[Math.floor(Math.random() * streets.length)]}, ${city}`;
}

function randomGarment() {
  const garments = ['Shalwar Kameez', 'Kurta Trouser', 'Sherwani', 'Waistcoat', 'Coat', 'Shirt', 'Trouser', 'Pant', 'Blazer', 'Jacket', 'Frock', 'Lehenga', 'Saree', 'Gown'];
  return garments[Math.floor(Math.random() * garments.length)];
}

function randomFabric() {
  const fabrics = ['Cotton', 'Linen', 'Silk', 'Wool', 'Velvet', 'Chiffon', 'Lawn', 'Cambric', 'Denim', 'Khaddar', 'Korai', 'Satin', 'Organza', 'Net', 'Jersey', 'Crepe', 'Georgette'];
  const colors = ['White', 'Black', 'Navy Blue', 'Maroon', 'Burgundy', 'Grey', 'Charcoal', 'Beige', 'Cream', 'Brown', 'Olive', 'Teal', 'Royal Blue', 'Emerald', 'Ruby', 'Gold', 'Silver'];
  return `${colors[Math.floor(Math.random() * colors.length)]} ${fabrics[Math.floor(Math.random() * fabrics.length)]}`;
}

function randomDesign() {
  const designs = ['Plain', 'Embroidery', 'Lace Work', 'Beaded', 'Sequin', 'Printed', 'Striped', 'Checked', 'Floral', 'Geometric', 'Traditional', 'Modern', 'Casual', 'Formal', 'Wedding', 'Party Wear'];
  return designs[Math.floor(Math.random() * designs.length)];
}

function randomAge() {
  return Math.floor(Math.random() * 60) + 18;
}

function randomPrice() {
  return Math.floor(Math.random() * 100000) + 2000;
}

function randomDiscount(price) {
  return Math.random() > 0.7 ? Math.floor(Math.random() * price * 0.2) : 0;
}

function randomAdvance(price) {
  return Math.random() > 0.6 ? Math.floor(Math.random() * price * 0.5) : 0;
}

function generateMeasurements() {
  if (Math.random() > 0.3) return null;
  
  return {
    kameeLength: (Math.random() * 10 + 35).toFixed(1),
    shoulder: (Math.random() * 6 + 14).toFixed(1),
    neck: (Math.random() * 4 + 13).toFixed(1),
    arms: (Math.random() * 6 + 20).toFixed(1),
    chest: (Math.random() * 8 + 34).toFixed(1),
    rMole: (Math.random() * 5 + 12).toFixed(1),
    fitting: (Math.random() * 4 + 2).toFixed(1),
    hem: (Math.random() * 10 + 40).toFixed(1),
    belly: (Math.random() * 8 + 32).toFixed(1),
    qaff: (Math.random() * 8 + 20).toFixed(1),
    armhole: (Math.random() * 4 + 16).toFixed(1),
    kaaf: (Math.random() * 8 + 38).toFixed(1),
    legs: (Math.random() * 8 + 18).toFixed(1),
    shalwarLength: (Math.random() * 6 + 36).toFixed(1),
    hip: (Math.random() * 8 + 38).toFixed(1),
    designType: randomDesign(),
    additional: 'Standard fitting as per measurements'
  };
}

// Main generation function
async function generateTestData() {
  console.log('🚀 Starting test data generation...\n');
  console.log(`📊 Configuration:`);
  console.log(`   - Clients: ${CONFIG.TOTAL_CLIENTS}`);
  console.log(`   - Orders per client: ${CONFIG.ORDERS_PER_CLIENT}`);
  console.log(`   - Total pending orders: ${CONFIG.PENDING_COUNT}`);
  console.log(`   - Total overdue orders: ${CONFIG.OVERDUE_COUNT}`);
  console.log(`   - Total unpaid orders: ${CONFIG.UNPAID_COUNT}\n`);

  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  let pendingAssigned = 0;
  let overdueAssigned = 0;
  let unpaidAssigned = 0;
  
  const clients = [];
  let uidCounter = 1;
  let ordCounter = 1;
  
  // Pre-calculate which orders get special status
  const specialOrders = [];
  for (let i = 0; i < CONFIG.PENDING_COUNT; i++) specialOrders.push({ type: 'pending' });
  for (let i = 0; i < CONFIG.OVERDUE_COUNT; i++) specialOrders.push({ type: 'overdue' });
  for (let i = 0; i < CONFIG.UNPAID_COUNT; i++) specialOrders.push({ type: 'unpaid' });
  
  // Shuffle
  for (let i = specialOrders.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [specialOrders[i], specialOrders[j]] = [specialOrders[j], specialOrders[i]];
  }
  
  let specialIdx = 0;
  
  // Generate clients
  for (let c = 0; c < CONFIG.TOTAL_CLIENTS; c++) {
    const clientId = `SO-${++uidCounter}`;
    const clientName = randomName();
    const clientAddedDate = randomDate(oneYearAgo, today);
    const isWalkIn = Math.random() > 0.3;
    
    const orders = [];
    
    for (let o = 0; o < CONFIG.ORDERS_PER_CLIENT; o++) {
      let orderCategory = 'completed';
      let deliveryDate;
      let status;
      let paidDate = null;
      
      if (specialIdx < specialOrders.length) {
        orderCategory = specialOrders[specialIdx].type;
        specialIdx++;
      }
      
      const orderPrice = randomPrice();
      const orderDiscount = randomDiscount(orderPrice);
      const orderAdvance = randomAdvance(orderPrice);
      
      if (orderCategory === 'pending') {
        deliveryDate = randomDate(today, new Date(today.getTime() + 30 * 24 * 60 * 60 * 100000));
        status = { status: 'pending', payStatus: Math.random() > 0.5 ? 'unpaid' : 'partial' };
        pendingAssigned++;
      } else if (orderCategory === 'overdue') {
        deliveryDate = randomDate(oneYearAgo, new Date(today.getTime() - 1));
        status = { status: 'pending', payStatus: Math.random() > 0.5 ? 'unpaid' : 'partial' };
        overdueAssigned++;
      } else if (orderCategory === 'unpaid') {
        deliveryDate = randomDate(oneYearAgo, today);
        status = { status: 'completed', payStatus: Math.random() > 0.6 ? 'unpaid' : 'partial' };
        paidDate = deliveryDate;
        unpaidAssigned++;
      } else {
        deliveryDate = randomDate(oneYearAgo, today);
        status = { status: 'completed', payStatus: 'paid' };
        paidDate = deliveryDate;
      }
      
      orders.push({
        id: `ORD-${ordCounter++}`,
        orders: Math.floor(Math.random() * 3) + 1,
        price: orderPrice,
        discount: orderDiscount,
        delivery: formatDate(deliveryDate),
        status: status.status,
        payStatus: status.payStatus,
        advance: status.payStatus === 'partial' ? orderAdvance : 0,
        paidDate: paidDate ? formatDate(paidDate) : null,
        garment: randomGarment(),
        fabric: randomFabric(),
        design: randomDesign(),
        images: []
      });
    }
    
    clients.push({
      uid: clientId,
      name: clientName,
      phone: randomPhone(),
      email: randomEmail(clientName),
      age: randomAge().toString(),
      city: randomCity(),
      address: randomAddress(randomCity()),
      tag: isWalkIn ? 'physical' : 'online',
      defaultDiscount: Math.random() > 0.8 ? Math.floor(Math.random() * 500) : 0,
      measurements: generateMeasurements(),
      addedDate: formatDate(clientAddedDate),
      orderList: orders
    });
    
    if ((c + 1) % 100 === 0) {
      console.log(`   Generated ${c + 1}/${CONFIG.TOTAL_CLIENTS} clients...`);
    }
  }
  
  // Workers
  const workers = [
    { id: 'W-1', name: 'Usman Ali', phone: '+92 300 1234567', specialty: 'Shalwar Kameez Specialist', rate: 800 },
    { id: 'W-2', name: 'Ahmed Raza', phone: '+92 301 2345678', specialty: 'Sherwani & Waistcoat', rate: 1200 },
    { id: 'W-3', name: 'Saeed Ahmed', phone: '+92 302 3456789', specialty: 'Western Wear', rate: 900 },
    { id: 'W-4', name: 'Tariq Mehmood', phone: '+92 303 4567890', specialty: 'Embroidery Expert', rate: 1000 },
    { id: 'W-5', name: 'Naveed Khan', phone: '+92 304 5678901', specialty: 'Bridal Wear', rate: 1500 },
    { id: 'W-6', name: 'Imran Ali', phone: '+92 305 6789012', specialty: 'Kurta & Trouser', rate: 750 },
    { id: 'W-7', name: 'Bilal Ahmed', phone: '+92 306 7890123', specialty: 'Children Wear', rate: 600 },
    { id: 'W-8', name: 'Farhan Aslam', phone: '+92 307 8901234', specialty: 'Leather & Jackets', rate: 1100 }
  ];
  
  // Assignments
  const assignments = [];
  let assCounter = 1;
  
  for (const client of clients) {
    for (const order of client.orderList) {
      if (Math.random() > 0.7 && order.status !== 'cancelled') {
        const worker = workers[Math.floor(Math.random() * workers.length)];
        const assignDate = order.delivery ? randomDate(new Date(order.delivery), new Date(order.delivery)) : randomDate(oneYearAgo, today);
        const progressStates = ['not_started', 'in_progress', 'half_done', 'almost_done', 'completed'];
        const progress = order.status === 'completed' ? 'completed' : progressStates[Math.floor(Math.random() * 4)];
        
        assignments.push({
          id: `ASS-${assCounter++}`,
          workerId: worker.id,
          clientUid: client.uid,
          task: `Stitch ${order.garment} for ${client.name} (${order.id})`,
          date: formatDate(assignDate),
          hours: Math.floor(Math.random() * 8) + 2,
          startNote: `Fabric: ${order.fabric}. Design: ${order.design}`,
          progress: progress,
          pct: progress === 'completed' ? 100 : Math.floor(Math.random() * 80) + 10,
          progressNote: progress !== 'completed' ? 'Work in progress' : 'Completed successfully',
          endNote: progress === 'completed' ? 'Order ready for delivery' : '',
          createdAt: new Date().toISOString()
        });
      }
    }
  }
  
  // Expenses
  const expenses = [];
  let expCounter = 1;
  const expenseCategories = ['Fabric', 'Rent', 'Salary', 'Equipment', 'Thread', 'Other'];
  const expenseDescriptions = [
    'Fabric purchase - bulk order', 'Monthly shop rent', 'Staff salary payment',
    'Sewing machine maintenance', 'Thread and accessories', 'Electricity bill',
    'Water bill', 'Marketing expenses', 'Packaging materials', 'Transportation'
  ];
  
  for (let i = 0; i < 200; i++) {
    const expenseDate = randomDate(oneYearAgo, today);
    expenses.push({
      id: `EXP-${expCounter++}`,
      desc: expenseDescriptions[Math.floor(Math.random() * expenseDescriptions.length)],
      amount: Math.floor(Math.random() * 50000) + 1000,
      date: formatDate(expenseDate),
      category: expenseCategories[Math.floor(Math.random() * expenseCategories.length)]
    });
  }
  
  expenses.sort((a, b) => new Date(a.date) - new Date(b.date));
  
  // Inventory
  const inventory = [];
  let invCounter = 1;
  const inventoryItems = [
    { name: 'White Cotton Fabric', category: 'Fabric', unit: 'meters', qty: 150, min: 20, note: 'Premium quality' },
    { name: 'Navy Blue Linen', category: 'Fabric', unit: 'meters', qty: 80, min: 15, note: 'Summer collection' },
    { name: 'Black Silk', category: 'Fabric', unit: 'meters', qty: 45, min: 10, note: 'Wedding special' },
    { name: 'Maroon Velvet', category: 'Fabric', unit: 'meters', qty: 60, min: 12, note: 'Winter collection' },
    { name: 'Grey Wool', category: 'Fabric', unit: 'meters', qty: 35, min: 8, note: 'Coats & jackets' },
    { name: 'White Thread', category: 'Thread', unit: 'pieces', qty: 200, min: 50, note: 'Universal' },
    { name: 'Black Thread', category: 'Thread', unit: 'pieces', qty: 180, min: 45, note: 'Heavy duty' },
    { name: 'Gold Buttons', category: 'Button', unit: 'pieces', qty: 500, min: 100, note: 'Decorative' },
    { name: 'Silver Zippers', category: 'Zipper', unit: 'pieces', qty: 300, min: 80, note: 'Various sizes' },
    { name: 'Cotton Lining', category: 'Lining', unit: 'meters', qty: 120, min: 30, note: 'Breathable' },
    { name: 'Red Chiffon', category: 'Fabric', unit: 'meters', qty: 25, min: 5, note: 'Limited stock' }
  ];
  
  for (const item of inventoryItems) {
    inventory.push({
      id: `INV-${invCounter++}`,
      name: item.name,
      category: item.category,
      unit: item.unit,
      qty: item.qty,
      min: item.min,
      note: item.note
    });
  }
  
  // Inventory history
  const invHistory = [];
  for (let i = 0; i < 100; i++) {
    const item = inventory[Math.floor(Math.random() * inventory.length)];
    const change = -(Math.floor(Math.random() * 10) + 1);
    invHistory.push({
      date: formatDate(randomDate(oneYearAgo, today)),
      item: item.name,
      category: item.category,
      change: change,
      unit: item.unit,
      note: `Used for order ORD-${Math.floor(Math.random() * 100000)}`
    });
  }
  
  // Salary payments
  const salaryPayments = [];
  let salCounter = 1;
  const months = ['2024-10', '2024-11', '2024-12', '2025-01', '2025-02', '2025-03'];
  
  for (const worker of workers) {
    for (const month of months) {
      if (Math.random() > 0.2) {
        salaryPayments.push({
          id: `SAL-${salCounter++}`,
          workerId: worker.id,
          month: month,
          amount: worker.rate * 26,
          type: 'salary',
          note: `Salary for ${month}`,
          date: formatDate(randomDate(new Date(month + '-01'), new Date(month + '-28')))
        });
      }
    }
  }
  
  // Settings
  const settings = {
    name: 'Stitch Outfitters',
    owner: 'Saqib Rajpoot',
    phone: '+92 300 1234567',
    address: 'Shop #12, Main Boulevard, Gulberg, Lahore',
    tagline: 'Quality Stitching Since 1995',
    waMsg: 'Your order is ready! Please collect by [delivery_date]. Thank you for choosing [shop_name].',
    _hasAccount: false
  };
  
  // Build complete data object
  const data = {
    clients,
    workers: workers.map(w => ({ ...w })),
    assignments,
    expenses,
    inventory,
    invHistory,
    salaryPayments,
    settings,
    uidC: uidCounter,
    ordC: ordCounter - 1,
    wrkC: workers.length,
    assC: assCounter - 1,
    expC: expCounter - 1,
    invC: invCounter - 1,
    salC: salCounter - 1
  };
  
  // Save to file
  const outputPath = path.join(__dirname, 'test-data.json');
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2));
  
  console.log('\n✅ Test data generation complete!\n');
  console.log('📈 Summary:');
  console.log(`   - Clients created: ${clients.length}`);
  console.log(`   - Total orders: ${ordCounter - 1}`);
  console.log(`   - Pending orders: ${pendingAssigned}`);
  console.log(`   - Overdue orders: ${overdueAssigned}`);
  console.log(`   - Unpaid orders: ${unpaidAssigned}`);
  console.log(`   - Completed orders: ${(ordCounter - 1) - (pendingAssigned + overdueAssigned + unpaidAssigned)}`);
  console.log(`   - Workers: ${workers.length}`);
  console.log(`   - Work assignments: ${assignments.length}`);
  console.log(`   - Expenses: ${expenses.length}`);
  console.log(`   - Inventory items: ${inventory.length}`);
  console.log(`   - Salary payments: ${salaryPayments.length}\n`);
  console.log(`💾 Data saved to: ${outputPath}`);
  console.log('\n📋 Next steps:');
  console.log('   1. Open Stitch Outfitters app');
  console.log('   2. Go to Settings → Data Management → Restore from JSON Backup');
  console.log('   3. Select the test-data.json file');
  console.log('   4. Wait for import (10-30 seconds for 5000 orders)');
  console.log('   5. The app will load all test data automatically\n');
}

// Run the generator
generateTestData().catch(console.error);