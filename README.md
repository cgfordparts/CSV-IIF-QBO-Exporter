# Shopify & IIF Transaction Converter

A professional desktop utility built with Electron and React to streamline financial data workflows between Shopify, PayPal, and QuickBooks Online (QBO).

## 🚀 Features

- **Shopify/PayPal Auditor:** Parse and audit CSV sales reports into a clean, searchable ledger.
- **IIF to QBO Converter:** Transform legacy Counterpoint `.iif` files into modern QuickBooks Online formats.
- **Direct QBO Integration:** Securely sync Journal Entries (GL) and Bills (AP) directly to your QuickBooks Online company via the official Intuit API.
- **PDF Reporting:** Generate high-fidelity transaction reports for auditing and record-keeping.

## 🛠️ Technical Stack

- **Frontend:** React 19, TypeScript, Tailwind CSS
- **Backend:** Electron 40, Node.js
- **API Integration:** Intuit OAuth2 SDK
- **Parsing:** PapaParse (.csv), Custom IIF Parser
- **Export:** jsPDF, AutoTable

## ⚙️ Setup & Configuration

### Prerequisites
- Node.js (v18+)
- QuickBooks Developer Account (for API keys)

### Installation
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```

### Environment Variables
Create a `.env` file in the root directory with the following:
```env
QB_CLIENT_ID=your_client_id
QB_CLIENT_SECRET=your_client_secret
QB_ENVIRONMENT=sandbox # or 'production'
QB_REDIRECT_URI=http://localhost:8080/callback
```

### Running the App (Development)
For developers working on the source code:
```bash
npm run electron:dev
```

### Packaging for Production (End Users)
To create a standalone `.exe` or installer for Windows:
```bash
npm run electron:build
```
The resulting installer will be located in the `release/` folder. End users can simply run the installer and use the application like any other desktop software without needing Node.js or a terminal.

## 🔒 Security & Privacy
This application is an internal business tool. All data processing occurs locally on the user's machine. Financial data is transmitted exclusively to QuickBooks Online via encrypted SSL/TLS connections using official Intuit OAuth2 protocols. No data is stored or shared with third parties.

---
Created by Yurei.
