const OAuthClient = require('intuit-oauth');

let oauthClient = null;

const initOAuth = () => {
  console.log('--- QB AUTH DEBUG ---');
  console.log('Environment:', process.env.QB_ENVIRONMENT);
  console.log('ID Starts With:', process.env.QB_CLIENT_ID ? process.env.QB_CLIENT_ID.substring(0, 5) : 'MISSING');
  console.log('Redirect URI:', process.env.QB_REDIRECT_URI);
  
  if (!process.env.QB_CLIENT_ID || !process.env.QB_CLIENT_SECRET) {
    console.error('Missing QuickBooks Credentials in .env');
    return null;
  }

  oauthClient = new OAuthClient({
    clientId: process.env.QB_CLIENT_ID.trim(),
    clientSecret: process.env.QB_CLIENT_SECRET.trim(),
    environment: (process.env.QB_ENVIRONMENT || 'sandbox').trim(),
    redirectUri: (process.env.QB_REDIRECT_URI || 'http://localhost:8080/callback').trim(),
  });

  return oauthClient;
};

const getAuthUri = () => {
  if (!oauthClient) initOAuth();
  
  return oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting, OAuthClient.scopes.OpenId],
    state: 'intuit-test',
  });
};

const exchangeAuthCode = async (url) => {
  if (!oauthClient) initOAuth();

  console.log('--- TOKEN EXCHANGE START ---');
  console.log('URL for Exchange:', url);

  try {
    const authResponse = await oauthClient.createToken(url);
    const token = authResponse.getJson();
    console.log('--- TOKEN EXCHANGE SUCCESS ---');
    return token;
  } catch (e) {
    console.error('--- TOKEN EXCHANGE FAILED ---');
    console.error('Status:', e.authResponse ? e.authResponse.response.status : 'N/A');
    console.error('Body:', e.authResponse ? e.authResponse.body : 'N/A');
    console.error('Intuit TID:', e.intuit_tid);
    throw e;
  }
};

const getClient = () => {
    if (!oauthClient) initOAuth();
    return oauthClient;
}

const getRealmId = () => {
    if (!oauthClient) return null;
    return oauthClient.getToken().realmId;
}

const isTokenValid = () => {
    if (!oauthClient) return false;
    return oauthClient.isAccessTokenValid();
}

const makeRequest = async (url, method = 'GET', body = null) => {
    if (!oauthClient) throw new Error('Not authenticated with QuickBooks');
    
    if (!oauthClient.isAccessTokenValid()) {
        console.log('Refreshing Token...');
        await oauthClient.refresh();
    }

    const requestObj = {
        url,
        method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        }
    };

    if (body) {
        requestObj.body = JSON.stringify(body);
    }

    try {
        const response = await oauthClient.makeApiCall(requestObj);
        // The API response object has a 'json' property, not a 'getJson()' method
        return response.json || JSON.parse(response.body);
    } catch (e) {
        console.error('API Call Failed:', e);
        throw e;
    }
}

module.exports = {
  initOAuth,
  getAuthUri,
  exchangeAuthCode,
  getClient,
  getRealmId,
  isTokenValid,
  makeRequest
};
