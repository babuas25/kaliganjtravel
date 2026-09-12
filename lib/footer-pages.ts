export type FooterPageItem = {
  label: string;
  text: string;
};

export type FooterPageSection = {
  title: string;
  paragraphs?: readonly string[];
  items?: readonly FooterPageItem[];
};

export type FooterPage = {
  slug: string;
  title: string;
  summary: string;
  sections: readonly FooterPageSection[];
};

export const FOOTER_PAGES = [
  {
    slug: 'about-us',
    title: 'About Us',
    summary:
      'We simplify global travel with reliable air ticketing and personalized visa processing support.',
    sections: [
      {
        title: 'Welcome to Kaliganj Travels',
        paragraphs: [
          'At Kaliganj Travels, we simplify global travel to make your journeys seamless, stress-free, and memorable. We are a trusted travel agency specializing in end-to-end air ticketing solutions and comprehensive visa processing services tailored to meet your unique needs.',
          'Whether you are planning a family vacation, an international business trip, or traveling for study or employment, our mission is to deliver fast, reliable, and cost-effective travel solutions. With deep industry expertise and access to extensive global airline networks, we manage your travel logistics so you can focus on your destination.',
        ],
      },
      {
        title: 'Why Choose Kaliganj Travels?',
        items: [
          {
            label: 'Seamless Air Ticketing',
            text: 'Competitive fares, flexible flight options, and fast bookings for domestic and international destinations.',
          },
          {
            label: 'Expert Visa Assistance',
            text: 'Personalized guidance and careful documentation support for a smooth, hassle-free visa application process.',
          },
          {
            label: 'Reliable Customer Care',
            text: 'Transparent advice and dedicated service to support you every step of the way.',
          },
        ],
      },
      {
        title: 'Your Journey Starts Here',
        paragraphs: [
          'Your journey begins with the right partner. Let Kaliganj Travels handle the details and connect you to the world.',
        ],
      },
    ],
  },
  {
    slug: 'careers',
    title: 'Careers',
    summary:
      'Build a rewarding career in the global travel industry with Kaliganj Travels.',
    sections: [
      {
        title: 'Careers at Kaliganj Travels',
        paragraphs: [
          'We are constantly growing and looking for passionate, client-focused individuals to help us deliver world-class air ticketing, visa consultancy, and travel management services.',
        ],
      },
      {
        title: 'Why Join Us?',
        items: [
          {
            label: 'Professional Environment',
            text: 'Work in a dynamic, customer-centric agency handling global distribution systems and international travel.',
          },
          {
            label: 'Skill Development',
            text: 'Gain hands-on experience in GDS platforms, embassy visa processing, and travel operations.',
          },
          {
            label: 'Growth Opportunities',
            text: 'Advance your career based on performance and dedication.',
          },
        ],
      },
      {
        title: 'Available Roles (Periodic Hiring)',
        items: [
          {
            label: 'Air Ticketing Executive / GDS Operator',
            text: 'Handle GDS systems, issue and reissue flight tickets, manage segments, and answer customer flight queries.',
          },
          {
            label: 'Visa Processing Consultant',
            text: 'Check documents, file embassy applications, guide clients, and track visa status.',
          },
          {
            label: 'Customer Support Representative',
            text: 'Assist clients by phone, WhatsApp, and office visits with travel itineraries and general inquiries.',
          },
        ],
      },
      {
        title: 'How to Apply',
        paragraphs: [
          'If you are passionate about travel and have strong communication or ticketing skills, we would love to hear from you.',
          'Send your updated CV to support@kaliganjtravel.com or drop it off at Kaliganj Travels, 1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh.',
        ],
      },
    ],
  },
  {
    slug: 'blog',
    title: 'Travel Blog',
    summary:
      'Expert travel tips, visa application guidance, airline updates, and destination inspiration.',
    sections: [
      {
        title: 'Welcome to Our Travel Blog',
        paragraphs: [
          'Stay informed and prepare for your next global journey with practical advice and travel news from Kaliganj Travels.',
        ],
      },
      {
        title: 'Latest Articles & Guides',
        items: [
          {
            label: 'Complete Guide to Umrah Visa & Air Ticketing from Bangladesh',
            text: 'Learn the steps for securing an Umrah visa, choosing routes to Jeddah or Madinah, and preparing for your first pilgrimage.',
          },
          {
            label: 'Top 5 Tips to Avoid Visa Rejections',
            text: 'See how bank statements, job NOCs, and a clear flight itinerary can strengthen a visa application.',
          },
          {
            label: 'How to Get the Best Airfares for International Flights',
            text: 'Understand when to book, explore flexible routes, and find flights that suit your travel plans with support from our team.',
          },
          {
            label: 'Essential Checklist Before Traveling Abroad',
            text: 'Review passport validity, baggage allowances, insurance, and other essentials before heading to the airport.',
          },
        ],
      },
      {
        title: 'Stay Updated',
        paragraphs: [
          'Follow Kaliganj Travels for travel updates, airline policy changes, and destination guides, or contact our team for personalized travel advice.',
        ],
      },
    ],
  },
  {
    slug: 'affiliates',
    title: 'Affiliates & Partners',
    summary:
      'Partner with us to expand access to seamless air ticketing and global visa processing services.',
    sections: [
      {
        title: 'Partner With Us',
        items: [
          {
            label: 'Sub-Agents & Freelance Agents',
            text: 'Access competitive airfares across major GDS platforms and offer visa processing support to your clients through our agency.',
          },
          {
            label: 'Corporate Partners',
            text: 'Receive tailored travel management solutions, including priority flight bookings, corporate visa handling, and flexible payment terms.',
          },
          {
            label: 'Referral Partners',
            text: 'Earn attractive commissions by referring clients for Umrah packages, work or student visa preparation, and international flight tickets.',
          },
        ],
      },
      {
        title: 'Why Partner With Kaliganj Travels?',
        items: [
          {
            label: 'Competitive B2B Rates',
            text: 'Access exclusive domestic and international fares across Middle Eastern, Asian, European, and transatlantic airlines.',
          },
          {
            label: 'Reliable GDS & Visa Support',
            text: 'Get fast support for ticketing, date reissues, ticket voiding, and embassy file preparation.',
          },
          {
            label: 'Dedicated Partner Desk',
            text: 'Use a direct communication line for urgent partner bookings and queries.',
          },
        ],
      },
      {
        title: 'How to Become a Partner',
        items: [
          {
            label: '1. Submit Your Application',
            text: 'Contact us with your agency details, business background, or partnership proposal.',
          },
          {
            label: '2. Verification & Setup',
            text: 'Our team will review your application and complete partner onboarding.',
          },
          {
            label: '3. Start Partnering',
            text: 'Access B2B travel solutions and begin growing your revenue with us.',
          },
        ],
      },
      {
        title: 'Contact Our Partnership Team',
        paragraphs: [
          'Visit our office at 1st Floor, Janata Super Market, Kaligonj, Jhenaidah, or contact us by WhatsApp or email to discuss affiliate and sub-agency opportunities.',
        ],
      },
    ],
  },
  {
    slug: 'help-center',
    title: 'Help Center',
    summary:
      'Answers and support for air ticketing, visa processing, payments, and travel-related questions.',
    sections: [
      {
        title: 'Air Ticketing Support',
        items: [
          {
            label: 'How do I receive my e-ticket after booking?',
            text: 'After your booking is confirmed and payment is verified, your e-ticket will be sent by email or WhatsApp, or handed to you at our office.',
          },
          {
            label: 'Can I change my flight date or cancel my ticket?',
            text: 'Yes. Changes and cancellations depend on airline rules and ticket class. Contact us with your booking reference (PNR) to check penalties and available options.',
          },
          {
            label: 'What is your same-day ticket void policy?',
            text: 'Void requests must be submitted on the same calendar day the ticket was issued and remain subject to airline approval, cut-off times, and applicable fees.',
          },
        ],
      },
      {
        title: 'Visa Processing Assistance',
        items: [
          {
            label: 'Does Kaliganj Travels guarantee visa approval?',
            text: 'No. Approval or rejection is entirely at the discretion of the embassy or high commission. We prepare applications and documents carefully to support the best possible submission.',
          },
          {
            label: 'Are visa processing and embassy fees refundable?',
            text: 'No. Embassy fees, visa application center charges, and agency service fees are non-refundable once an application is submitted.',
          },
          {
            label: 'What documents are required for my visa?',
            text: 'Requirements vary by country and visa type. Contact our visa consultants for a customized document checklist.',
          },
        ],
      },
      {
        title: 'Payments & Verification',
        items: [
          {
            label: 'What payment methods do you accept?',
            text: 'We accept cash at our office, bank transfers, and standard mobile financial services (MFS). Always request an official receipt.',
          },
        ],
      },
      {
        title: 'Need Further Assistance?',
        paragraphs: [
          'Contact our support team for assistance and current office hours. Call +880 1795-271171, message us on WhatsApp at +880 1795-271171, or email support@kaliganjtravel.com.',
        ],
      },
    ],
  },
  {
    slug: 'contact-us',
    title: 'Contact Us',
    summary:
      'Contact our team for flight bookings, visa guidance, cancellations, refunds, and trip planning.',
    sections: [
      {
        title: 'Get in Touch',
        items: [
          {
            label: 'Office Address',
            text: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh',
          },
          { label: 'Phone / Mobile', text: '+880 1795-271171' },
          { label: 'WhatsApp', text: '+880 1795-271171' },
          { label: 'Email', text: 'support@kaliganjtravel.com' },
          { label: 'Facebook', text: 'facebook.com/KaligonjTourTravel' },
        ],
      },
      {
        title: 'Business Hours',
        items: [
          { label: 'Office hours', text: 'Please call or message us to confirm current opening hours.' },
          {
            label: 'Before visiting',
            text: 'Contact our Kaligonj office to arrange assistance.',
          },
        ],
      },
      {
        title: 'Send Us a Message',
        paragraphs: [
          'When contacting us, please include your full name, phone number, email address, the service you need, and a brief message. For an existing booking, include your PNR or booking reference.',
          'We look forward to helping you with your journey.',
        ],
      },
    ],
  },
  {
    slug: 'booking-guide',
    title: 'Booking Guide',
    summary:
      'Follow these simple steps to book flight tickets or apply for visa processing assistance.',
    sections: [
      {
        title: 'How to Book Flight Tickets',
        items: [
          {
            label: '1. Submit Your Request',
            text: 'Provide departure and arrival cities, travel dates, passenger details exactly as shown on the passport, and your preferred travel class by phone, WhatsApp, or at our office.',
          },
          {
            label: '2. Choose Your Option',
            text: 'Our team will send available itineraries, fare options, and baggage allowances.',
          },
          {
            label: '3. Verify Passenger Details',
            text: 'Carefully check passenger names, dates, and passport validity. Passports should remain valid for at least six months.',
          },
          {
            label: '4. Make Payment',
            text: 'Confirm your flight by completing payment through cash, bank transfer, or MFS.',
          },
          {
            label: '5. Receive Your E-Ticket',
            text: 'After payment is verified, your official e-ticket will be sent by email or WhatsApp, or printed at our office.',
          },
        ],
      },
      {
        title: 'How to Apply for Visa Assistance',
        items: [
          {
            label: '1. Initial Consultation',
            text: 'Tell us your destination country and travel purpose, such as tourism, business, study, or work.',
          },
          {
            label: '2. Prepare Your Documents',
            text: 'We will provide a customized checklist. Submit original documents or clear scanned copies to our office.',
          },
          {
            label: '3. Application & Processing',
            text: 'We prepare your application, arrange supporting flight and hotel bookings, and assist with submission to the embassy or visa center.',
          },
          {
            label: '4. Visa Status & Delivery',
            text: 'We track the available status and notify you when the passport or visa is ready for collection.',
          },
        ],
      },
      {
        title: 'Important Notes for Travelers',
        items: [
          {
            label: 'Passenger Names',
            text: 'Double-check the spelling of every name against the passport before ticket issuance.',
          },
          {
            label: 'Fare Changes',
            text: 'Ticket prices may change until the booking is fully confirmed with payment.',
          },
          {
            label: 'Visa Fees',
            text: 'Embassy fees and processing charges are non-refundable once applicable work or submission has begun.',
          },
        ],
      },
    ],
  },
  {
    slug: 'cancellation',
    title: 'Cancellation Policy',
    summary:
      'Cancellations and refunds are handled according to airline fare rules, embassy guidelines, and our service policies.',
    sections: [
      {
        title: 'Air Ticket Cancellation Policy',
        items: [
          {
            label: 'Airline Rules Apply',
            text: 'Ticket cancellations, date changes, and refunds are governed by the issuing airline’s fare rules and restrictions.',
          },
          {
            label: 'Non-Refundable Tickets',
            text: 'Promotional, discounted, or non-refundable tickets cannot be refunded once issued.',
          },
          {
            label: 'Agency Service Charge',
            text: 'An administrative fee applies in addition to any airline penalty for a cancellation or refund request.',
          },
          {
            label: 'Same-Day Cancellation',
            text: 'Requests made on the issue date are subject to our ticket void policy and airline operational cut-off times.',
          },
        ],
      },
      {
        title: 'Visa Processing Cancellation Policy',
        items: [
          {
            label: 'Non-Refundable Embassy Fees',
            text: 'Once an application is submitted or appointment fees are paid, embassy, visa center, and agency service fees are non-refundable.',
          },
          {
            label: 'Pre-Submission Cancellation',
            text: 'If you cancel before embassy submission, administrative fees for documentation work already completed will be deducted from any eligible refund.',
          },
        ],
      },
      {
        title: 'Refund Procedure & Timeline',
        items: [
          {
            label: 'Written Request',
            text: 'Submit your request by email or WhatsApp with your PNR, ticket or passport copy, and payment receipt.',
          },
          {
            label: 'Processing Time',
            text: 'Approved air ticket refunds generally take 7 to 21 working days, depending on airline clearance and bank processing cycles.',
          },
          {
            label: 'Payment Credit',
            text: 'Refunds are returned through the original payment channel or disbursed by bank transfer or office collection, as applicable.',
          },
        ],
      },
    ],
  },
  {
    slug: 'refunds',
    title: 'Refund Policy',
    summary:
      'We maintain a transparent refund process aligned with airline terms, embassy regulations, and office policies.',
    sections: [
      {
        title: 'Air Ticket Refunds',
        items: [
          {
            label: 'Airline Rules',
            text: 'Refunds are subject to the airline’s fare conditions. Tickets marked non-refundable cannot be refunded.',
          },
          {
            label: 'Frequent Flyer / Reward Tickets',
            text: 'Tickets issued or upgraded with miles, points, or loyalty programs are non-refundable and non-changeable through the agency. Mileage adjustments must be handled with the airline.',
          },
          {
            label: 'Service Fees',
            text: 'Our processing fee and any airline cancellation penalties are deducted from the eligible refund amount.',
          },
          {
            label: 'Unused Segments',
            text: 'Partially used tickets are evaluated under airline rules and may have no remaining refund value.',
          },
        ],
      },
      {
        title: 'Visa Service Fees',
        paragraphs: [
          'Embassy fees, visa center charges, and agency processing fees are non-refundable once an application has been processed or submitted, regardless of the visa decision.',
        ],
      },
      {
        title: 'Refund Claim Procedure',
        items: [
          {
            label: '1. Submission',
            text: 'Submit a written request by email, WhatsApp, or at our office with the ticket or PNR, passport copy, and payment receipt.',
          },
          {
            label: '2. Verification',
            text: 'Our team calculates the net refund after airline penalties and agency service charges.',
          },
          {
            label: '3. Approval',
            text: 'Once agreed, the request is forwarded to the airline or system supplier for settlement.',
          },
        ],
      },
      {
        title: 'Refund Timeline & Payout',
        items: [
          {
            label: 'Timeline',
            text: 'Standard air ticket refunds take 7 to 21 working days, depending on airline settlement and banking channels.',
          },
          {
            label: 'Payout Method',
            text: 'Eligible refunds are issued through the original payment method, including bank transfer, MFS, or cash collection at our office.',
          },
        ],
      },
    ],
  },
  {
    slug: 'destinations',
    title: 'Destinations',
    summary:
      'Explore popular destinations for holidays, spiritual journeys, business, medical travel, and education.',
    sections: [
      {
        title: 'Asia & the Middle East',
        items: [
          {
            label: 'Saudi Arabia',
            text: 'Dedicated ticketing and visa processing support for Hajj, Umrah, work, and tourism.',
          },
          {
            label: 'Malaysia, Singapore & Thailand',
            text: 'Popular choices for holidays, medical travel, shopping, study, and work.',
          },
          {
            label: 'United Arab Emirates',
            text: 'Convenient Dubai and Abu Dhabi flight options with visa processing assistance for business and tourism.',
          },
          {
            label: 'India, Nepal & Sri Lanka',
            text: 'Accessible options for short holidays, family visits, and medical treatment.',
          },
        ],
      },
      {
        title: 'Europe & the Schengen Zone',
        paragraphs: [
          'We provide documentation support, appointment guidance, itinerary preparation, and air ticketing for the United Kingdom, Schengen countries, and Southern Europe.',
        ],
      },
      {
        title: 'North America & Beyond',
        paragraphs: [
          'Access reliable flight bookings and visa guidance for the United States, Canada, Australia, and other long-haul destinations.',
        ],
      },
      {
        title: 'Services for Every Destination',
        items: [
          { label: 'Air Ticketing', text: 'Competitive fares across major domestic and international airlines.' },
          { label: 'Visa Support', text: 'Tailored consultation and document checking for your destination.' },
          { label: 'Trip Planning', text: 'Hotel reservations and practical travel itinerary planning.' },
        ],
      },
    ],
  },
  {
    slug: 'flight-routes',
    title: 'Flight Routes',
    summary:
      'Domestic and international flight options from Bangladesh for work, study, tourism, business, and pilgrimage.',
    sections: [
      {
        title: 'Middle East Routes',
        items: [
          { label: 'Dhaka / Chattogram ⇄ Jeddah / Madinah', text: 'Direct and connecting flights for Umrah, Hajj, and employment travel.' },
          { label: 'Dhaka ⇄ Riyadh / Dammam', text: 'Frequent options for employment and business travel.' },
          { label: 'Dhaka ⇄ Dubai / Sharjah / Abu Dhabi', text: 'Fast connections with major Middle Eastern carriers.' },
          { label: 'Dhaka ⇄ Doha / Muscat / Kuwait', text: 'Regular departures with flexible baggage options.' },
        ],
      },
      {
        title: 'Southeast Asia & Far East Routes',
        items: [
          { label: 'Dhaka ⇄ Kuala Lumpur', text: 'A popular route for tourism, work, and student travel.' },
          { label: 'Dhaka ⇄ Bangkok', text: 'Convenient for holidays, shopping, and medical travel.' },
          { label: 'Dhaka ⇄ Singapore', text: 'Business, leisure, and onward transit connections.' },
        ],
      },
      {
        title: 'Long-Haul & Transit Routes',
        items: [
          { label: 'Dhaka ⇄ London / Manchester / Europe', text: 'One-stop connections through major Gulf hubs.' },
          { label: 'Dhaka ⇄ Toronto / New York / USA & Canada', text: 'Transatlantic options with flexible transit times.' },
        ],
      },
      {
        title: 'Domestic Routes',
        paragraphs: [
          'Book quick domestic flights from Dhaka to Cox’s Bazar, Sylhet, Chattogram, Saidpur, Rajshahi, and other destinations across Bangladesh.',
        ],
      },
      {
        title: 'Why Book Your Route With Us?',
        items: [
          { label: 'Multiple Airline Options', text: 'Compare Biman Bangladesh, Saudia, Emirates, Qatar Airways, US-Bangla, Air Arabia, Gulf Air, flydubai, and more.' },
          { label: 'Customized Itineraries', text: 'Choose practical transit times, baggage options, and preferred seating where available.' },
          { label: 'Special Group & Labour Fares', text: 'Ask about discounted options for groups and migrant workers.' },
        ],
      },
    ],
  },
  {
    slug: 'travel-guides',
    title: 'Travel Guide',
    summary:
      'A practical checklist for planning a smooth international or domestic journey from Bangladesh.',
    sections: [
      {
        title: 'Essential Travel Checklist',
        items: [
          { label: 'Passport Validity', text: 'Ensure your passport is valid for at least six months from your intended travel date.' },
          { label: 'Visa & Documentation', text: 'Keep printed copies of your visa, e-ticket, hotel confirmation, return ticket, and supporting documents.' },
          { label: 'Travel Insurance', text: 'Arrange appropriate coverage for medical emergencies, trip cancellations, and lost baggage.' },
        ],
      },
      {
        title: 'Airport & Flight Preparation',
        items: [
          { label: 'Reporting Time', text: 'Arrive 3 to 4 hours before international flights and 1.5 to 2 hours before domestic flights.' },
          { label: 'Baggage Limits', text: 'Check the cabin and checked baggage allowance shown on your ticket before arriving at the airport.' },
          { label: 'Restricted Items', text: 'Follow airline security rules for liquids, sharp objects, batteries, and power banks. Power banks belong in cabin baggage, not checked luggage.' },
        ],
      },
      {
        title: 'Country-Specific Travel Tips',
        items: [
          { label: 'Middle East (Umrah & Work)', text: 'Carry required medical certificates, keep passport copies available, and follow local laws and dress requirements.' },
          { label: 'Southeast Asia', text: 'Keep hotel bookings, proof of funds, and return tickets ready for immigration checks.' },
          { label: 'Europe & Long-Haul Trips', text: 'Carry invitation letters, insurance, accommodation evidence, and other supporting documents in your cabin baggage.' },
        ],
      },
      {
        title: 'Why Travel With Us?',
        items: [
          { label: 'End-to-End Assistance', text: 'Get help with air ticketing, visa processing, and route guidance.' },
          { label: 'Dedicated Support', text: 'Contact our team for transit questions, date reissues, and urgent flight updates.' },
        ],
      },
    ],
  },
  {
    slug: 'visa-info',
    title: 'Visa Information',
    summary:
      'Step-by-step visa assistance for tourism, employment, Umrah, business, study, and family travel.',
    sections: [
      {
        title: 'Country-Wise Visa Services',
        items: [
          { label: 'Saudi Arabia', text: 'Documentation, e-visa processing, biometric guidance, and Umrah package integration for Umrah, work, and tourist visas.' },
          { label: 'Malaysia, Singapore & Thailand', text: 'E-visa support, sticker visa submission, and tourism or business file preparation.' },
          { label: 'United Arab Emirates', text: 'Support for available short-term Dubai and Abu Dhabi tourist visa options.' },
          { label: 'Schengen & European Union', text: 'File preparation, appointment guidance, cover letter drafting, and itinerary support for the UK and Schengen countries.' },
          { label: 'India, Nepal & Regional Visas', text: 'Assistance with applicable tourist, medical, and regional travel permissions.' },
        ],
      },
      {
        title: 'General Document Checklist',
        items: [
          { label: 'Passport', text: 'An original passport valid for at least six months with a minimum of two blank pages.' },
          { label: 'Photographs', text: 'Recent lab-printed passport photos with a white background in the size required by the destination.' },
          { label: 'Bank Statement & Solvency', text: 'Typically, a six-month bank statement and a bank solvency certificate.' },
          { label: 'Business Owners', text: 'Trade license, company letterhead, visiting card, and translations or notarization where required.' },
          { label: 'Employees', text: 'No Objection Certificate, official ID, salary certificate, or payslips.' },
          { label: 'Students', text: 'Student ID and a leave NOC from the educational institution.' },
          { label: 'Travel Documents', text: 'Flight reservation, hotel booking, and a clear travel itinerary.' },
        ],
      },
      {
        title: 'Visa Disclaimer & Embassy Policy',
        items: [
          { label: 'Approval Authority', text: 'Visa approval, rejection, and timing remain solely at the discretion of the relevant embassy or high commission.' },
          { label: 'Non-Refundable Charges', text: 'Embassy, visa center, and agency service fees are non-refundable once processing or submission has begun.' },
        ],
      },
    ],
  },
  {
    slug: 'travel-insurance',
    title: 'Travel Insurance',
    summary:
      'Protect your journey from unexpected medical costs, disruption, and document or baggage loss.',
    sections: [
      {
        title: 'Why Do You Need Travel Insurance?',
        items: [
          { label: 'Embassy & Visa Requirements', text: 'Coverage is mandatory for Schengen visas and may be required for other destinations.' },
          { label: 'Emergency Medical Expenses', text: 'Policies may cover eligible hospital stays, consultations, and emergency treatment abroad.' },
          { label: 'Flight Disruptions', text: 'Depending on the policy, coverage may apply to delays, missed connections, or trip cancellations.' },
          { label: 'Lost or Delayed Luggage', text: 'Receive financial protection where covered baggage is lost, damaged, or delayed.' },
          { label: 'Passport & Document Loss', text: 'Some plans provide assistance with emergency travel document replacement.' },
        ],
      },
      {
        title: 'Travel Insurance Options',
        items: [
          { label: 'Schengen & Europe Coverage', text: 'Plans designed to meet applicable embassy requirements, including the standard minimum medical coverage where required.' },
          { label: 'Middle East & Asia Coverage', text: 'Budget-conscious options for tourism, Umrah, and short-term travel.' },
          { label: 'Worldwide Comprehensive Coverage', text: 'Broader plans for long-haul destinations such as Canada, the United States, and Australia.' },
          { label: 'Student & Work Insurance', text: 'Longer-term options tailored to international students and migrant workers.' },
        ],
      },
      {
        title: 'How to Get Covered',
        items: [
          { label: '1. Provide Your Details', text: 'Send your passport copy, travel dates, and destination country.' },
          { label: '2. Select a Plan', text: 'Choose a policy duration and coverage amount suited to your trip and visa requirements.' },
          { label: '3. Receive Your Policy', text: 'After issuance, receive the policy by email, WhatsApp, or as a printout from our office.' },
        ],
      },
    ],
  },
  {
    slug: 'privacy-policy',
    title: 'Privacy Policy',
    summary:
      'How Kaliganj Travels collects, uses, shares, and safeguards personal information.',
    sections: [
      {
        title: '1. Information We Collect',
        items: [
          { label: 'Personal Identification', text: 'Name, date of birth, gender, passport details, passport copies, and national identification details required for your service.' },
          { label: 'Contact Information', text: 'Phone number, email address, mailing address, and emergency contact details.' },
          { label: 'Travel Information', text: 'Itineraries, travel dates, visa application details, supporting documents, and travel preferences.' },
          { label: 'Payment Data', text: 'Transaction history, payment proof, and billing details needed to process bookings.' },
        ],
      },
      {
        title: '2. How We Use Your Information',
        items: [
          { label: 'Bookings', text: 'Book and issue flight tickets through global distribution systems, consolidators, and airlines.' },
          { label: 'Visa Services', text: 'Prepare and assist with visa applications to embassies or visa centers.' },
          { label: 'Communication', text: 'Send flight updates, schedule changes, visa status information, and booking confirmations.' },
          { label: 'Customer Care', text: 'Provide support and process eligible refunds, cancellations, or ticket reissues.' },
          { label: 'Compliance', text: 'Meet legal, regulatory, airline, and embassy requirements.' },
        ],
      },
      {
        title: '3. Sharing and Disclosure',
        paragraphs: [
          'We do not sell, rent, or trade personal data. We share information only where necessary to provide the requested service or meet a legal obligation.',
        ],
        items: [
          { label: 'Airlines & Consolidators', text: 'To issue tickets and manage reservations.' },
          { label: 'Embassies & Visa Centers', text: 'To process visa applications on your behalf.' },
          { label: 'Service Providers', text: 'To support payments, communications, and the technology used to operate our services.' },
          { label: 'Legal Authorities', text: 'When disclosure is required by law, regulation, or court order.' },
        ],
      },
      {
        title: '4. Data Security',
        paragraphs: [
          'We use appropriate technical and organizational safeguards against unauthorized access, loss, misuse, or alteration. Physical visa documents are stored securely and handled for official processing.',
        ],
      },
      {
        title: '5. Data Retention',
        paragraphs: [
          'We retain personal information only as long as needed to provide services, complete bookings, resolve support requests, and comply with statutory record-keeping obligations.',
        ],
      },
      {
        title: '6. Your Rights',
        paragraphs: [
          'You may request access to your information, ask us to correct inaccurate data, or request deletion after your service is completed, subject to legal, airline, accounting, and regulatory retention requirements.',
        ],
      },
      {
        title: '7. Third-Party Links',
        paragraphs: [
          'Our website and communications may link to airline, embassy, or other third-party websites. We are not responsible for their content or privacy practices.',
        ],
      },
      {
        title: '8. Updates to This Policy',
        paragraphs: [
          'We may update this policy to reflect changes in our services or legal obligations. The latest version will remain available on this page.',
        ],
      },
      {
        title: '9. Contact Us',
        paragraphs: [
          'For privacy questions or requests, contact Kaliganj Travels at support@kaliganjtravel.com or through our official phone and WhatsApp channels.',
        ],
      },
    ],
  },
  {
    slug: 'terms-and-conditions',
    title: 'Terms & Conditions',
    summary:
      'The terms governing flight booking, ticket servicing, visa assistance, cancellations, refunds, and use of our services.',
    sections: [
      {
        title: '1. General Booking & Payments',
        items: [
          { label: 'Availability', text: 'All bookings and reservations are subject to availability and final confirmation.' },
          { label: 'Payment', text: 'Full or partial payment must be made under the agreed service terms before ticket issuance or visa submission.' },
          { label: 'Fare Changes', text: 'Fares and prices may change without notice until tickets are issued or bookings are confirmed.' },
        ],
      },
      {
        title: '2. Air Ticketing & Flight Policies',
        items: [
          { label: 'Reissue & Cancellation', text: 'Cancellations, reissues, refunds, and date changes are governed by the airline’s policies and the ticket’s fare rules.' },
          { label: 'Service Charges', text: 'Our administrative service fee applies in addition to any airline penalty for reissues, cancellations, or refunds.' },
          { label: 'Travel Documents', text: 'Passengers must verify their names, dates, passport validity, and visa requirements before ticket issuance.' },
        ],
      },
      {
        title: '3. Same-Day Ticket Void Policy',
        items: [
          { label: 'Eligibility & Timeframe', text: 'Void requests depend on airline rules and cut-off times and generally must be made on the same calendar day as issuance, before billing closure.' },
          { label: 'Applicable Fees', text: 'A successful void may still carry airline charges and our administrative service fee.' },
          { label: 'Non-Voidable Tickets', text: 'Promotional, instant-purchase, non-refundable, or near-departure tickets may not qualify. Standard cancellation and refund rules then apply.' },
        ],
      },
      {
        title: '4. Visa Processing Assistance',
        items: [
          { label: 'Approval Disclaimer', text: 'We provide consultation, document preparation, and submission assistance. Visa decisions and processing times remain solely with the embassy or high commission.' },
          { label: 'Non-Refundable Fees', text: 'Embassy fees, processing center charges, and agency service fees are non-refundable once processing or submission has begun.' },
          { label: 'Document Authenticity', text: 'Clients must provide genuine, accurate, and current documents. We are not liable for outcomes caused by false or incorrect information supplied by an applicant.' },
        ],
      },
      {
        title: '5. Cancellations & Refunds',
        paragraphs: [
          'Refund requests must be submitted in writing. Eligibility and processing time depend on the airline, embassy, or third-party service provider involved.',
        ],
      },
      {
        title: '6. Limitation of Liability',
        paragraphs: [
          'Kaliganj Travels is not responsible for airline delays, schedule changes, cancellations, baggage loss, or disruptions caused by airlines, weather, natural disasters, government restrictions, or other events outside our control.',
        ],
      },
      {
        title: '7. Contact Us',
        paragraphs: [
          'For questions about these terms, contact us through our official office, phone, WhatsApp, or email channels.',
        ],
      },
    ],
  },
] as const satisfies readonly FooterPage[];

export type FooterPageSlug = (typeof FOOTER_PAGES)[number]['slug'];

export const FOOTER_PAGE_BY_SLUG: ReadonlyMap<string, FooterPage> = new Map(
  FOOTER_PAGES.map((page) => [page.slug, page])
);
