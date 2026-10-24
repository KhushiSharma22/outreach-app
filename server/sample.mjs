// Fictional sample contacts for trying the workflow. Addresses use the reserved .example domain.
// Signal dates are generated relative to today so the sample stays within freshness windows.
const NAMES = ['Aarav Mehta', 'Ananya Rao', 'Kabir Sethi', 'Meera Iyer', 'Rohan Shah', 'Tara Kapoor', 'Dev Malhotra', 'Priya Nair', 'Arjun Bhat', 'Riya Sen', 'Neil Sinha', 'Isha Patel', 'Vikram Bose', 'Sana Ali', 'Aditya Jain', 'Naina Gupta', 'Rahul Menon', 'Maya Desai', 'Kunal Roy', 'Diya Verma', 'Ankit Shah', 'Leena Das', 'Siddharth Rao', 'Avni Joshi', 'Nikhil Kapoor', 'Zoya Khan', 'Varun Singh', 'Pooja Mehta', 'Sameer Rao', 'Aditi Bose', 'Farhan Qureshi', 'Ira Banerjee', 'Manav Arora', 'Tanvi Kulkarni', 'Yash Thakur', 'Nisha Pillai', 'Omar Siddiqui', 'Kavya Reddy'];
const COMPANIES = ['Layerbase', 'Metricflow', 'Stacklane', 'Orbitdesk', 'Fableworks', 'Northbeam Labs', 'Loopcraft', 'Brightdesk', 'Relaypath', 'Cloudnest', 'Threadwise', 'Scalegrid', 'Draftline', 'Signalnest', 'Fieldkit', 'Launchwell', 'Bytehaven', 'Workloom', 'Daybreak', 'Cohortly', 'Teamforge', 'Pointwise', 'Nimblepath', 'Growframe', 'Crestline', 'Taskfield', 'Waymark', 'Zentro', 'Openfield', 'Flowlane', 'Quillstack', 'Harborly', 'Pinecast', 'Tidewater', 'Mosaic Ops', 'Keystone HQ', 'Vantage Grid', 'Lumen Path'];
const SIGNALS = [['Hiring', 'is hiring three sales development representatives'], ['Funding', 'announced a seed round to grow its commercial team'], ['New leadership', 'appointed a new head of growth'], ['Expansion', 'is expanding into a second market']];
const CITIES = ['Bengaluru, India', 'Mumbai, India', 'Pune, India', 'Delhi, India', 'Hyderabad, India'];

export function sampleCsv(today = new Date()) {
  const day = n => new Date(today.getTime() - n * 864e5).toISOString().slice(0, 10);
  const q = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const rows = [['first_name', 'last_name', 'email', 'email_status', 'title', 'company', 'domain', 'industry', 'employees', 'location', 'linkedin_url', 'relationship', 'signal', 'signal_fact', 'signal_date', 'signal_url']];
  NAMES.forEach((name, i) => {
    const [first, last] = name.split(' '), company = COMPANIES[i], domain = company.toLowerCase().replace(/ /g, '') + '.example';
    const [signal, fact] = SIGNALS[i % 4];
    let email = `${first.toLowerCase()}@${domain}`, status = 'valid', title = i % 3 ? 'Head of Growth' : 'Founder & CEO', industry = 'B2B SaaS', employees = 20 + (i * 7) % 170, location = CITIES[i % 5], rel = '', date = day(2 + (i % 20));
    if (i === 30) status = 'unknown';                       // needs verification
    if (i === 31) { email = ''; }                           // LinkedIn only: needs an email
    if (i === 32) rel = 'customer';                         // existing customer: excluded
    if (i === 33) employees = 2400;                         // outside size filter
    if (i === 34) date = day(120);                          // stale signal
    if (i === 35) date = '';                                // unknown event date
    if (i === 36) location = 'Austin, United States';       // outside location filter
    if (i === 37) status = 'catch-all';
    rows.push([first, last, email, email ? status : '', title, company, domain, industry, employees, location, `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-sample`, rel, signal, `${company} ${fact}.`, date, `https://${domain}/news`]);
  });
  return rows.map(r => r.map(q).join(',')).join('\n') + '\n';
}
