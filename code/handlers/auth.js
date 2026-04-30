'use strict';
/**
 * User Authentication Lambda Handler
 * Handles: POST /auth/register, POST /auth/login, POST /auth/refresh, POST /auth/logout
 * AWS Service: Amazon Cognito User Pools
 */

const { CognitoIdentityProviderClient,
  SignUpCommand, InitiateAuthCommand, GlobalSignOutCommand,
  ConfirmSignUpCommand, ResendConfirmationCodeCommand
} = require('@aws-sdk/client-cognito-identity-provider');

const cognito = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION });
const CLIENT_ID = process.env.COGNITO_CLIENT_ID;

// ─── Helpers ────────────────────────────────────────────────────────────────
const response = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  },
  body: JSON.stringify(body),
});

const parseBody = (event) => {
  try { return JSON.parse(event.body || '{}'); }
  catch { return {}; }
};

// ─── Register ────────────────────────────────────────────────────────────────
const register = async (body) => {
  const { email, password, name } = body;
  if (!email || !password || !name)
    return response(400, { error: 'email, password and name are required' });

  await cognito.send(new SignUpCommand({
    ClientId: CLIENT_ID,
    Username: email,
    Password: password,
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'name', Value: name },
    ],
  }));

  return response(201, {
    message: 'Registration successful. Please verify your email.',
    email,
  });
};

// ─── Confirm Email ────────────────────────────────────────────────────────────
const confirmEmail = async (body) => {
  const { email, code } = body;
  if (!email || !code)
    return response(400, { error: 'email and code are required' });

  await cognito.send(new ConfirmSignUpCommand({
    ClientId: CLIENT_ID,
    Username: email,
    ConfirmationCode: code,
  }));

  return response(200, { message: 'Email confirmed. You can now log in.' });
};

// ─── Login ───────────────────────────────────────────────────────────────────
const login = async (body) => {
  const { email, password } = body;
  if (!email || !password)
    return response(400, { error: 'email and password are required' });

  const result = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: { USERNAME: email, PASSWORD: password },
  }));

  const { AccessToken, IdToken, RefreshToken, ExpiresIn } = result.AuthenticationResult;
  return response(200, {
    accessToken: AccessToken,
    idToken: IdToken,
    refreshToken: RefreshToken,
    expiresIn: ExpiresIn,
  });
};

// ─── Refresh Token ───────────────────────────────────────────────────────────
const refreshToken = async (body) => {
  const { refreshToken: token } = body;
  if (!token) return response(400, { error: 'refreshToken is required' });

  const result = await cognito.send(new InitiateAuthCommand({
    ClientId: CLIENT_ID,
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    AuthParameters: { REFRESH_TOKEN: token },
  }));

  const { AccessToken, IdToken, ExpiresIn } = result.AuthenticationResult;
  return response(200, { accessToken: AccessToken, idToken: IdToken, expiresIn: ExpiresIn });
};

// ─── Logout ───────────────────────────────────────────────────────────────────
const logout = async (event) => {
  const token = (event.headers?.Authorization || '').replace('Bearer ', '');
  if (!token) return response(400, { error: 'Authorization header missing' });

  await cognito.send(new GlobalSignOutCommand({ AccessToken: token }));
  return response(200, { message: 'Logged out successfully' });
};

// ─── Main Handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const path = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  const body = parseBody(event);

  try {
    if (method === 'POST' && path.endsWith('/register'))   return await register(body);
    if (method === 'POST' && path.endsWith('/confirm'))    return await confirmEmail(body);
    if (method === 'POST' && path.endsWith('/login'))      return await login(body);
    if (method === 'POST' && path.endsWith('/refresh'))    return await refreshToken(body);
    if (method === 'POST' && path.endsWith('/logout'))     return await logout(event);
    return response(404, { error: 'Route not found' });
  } catch (err) {
    console.error('Auth error:', err);
    const status = err.name === 'NotAuthorizedException' ? 401
      : err.name === 'UsernameExistsException' ? 409
      : err.name === 'UserNotFoundException' ? 404
      : err.name === 'InvalidPasswordException' ? 400 : 500;
    return response(status, { error: err.message });
  }
};
