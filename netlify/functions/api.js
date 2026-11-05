const serverless = require('serverless-http');
const { createApp } = require('../../app');

const handleRequest = serverless(createApp());

exports.handler = async (event, context) => {
  // Open MongoDB sockets should survive for the next warm invocation.
  context.callbackWaitsForEmptyEventLoop = false;
  return handleRequest(event, context);
};
