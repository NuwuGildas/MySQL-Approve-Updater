'use strict';
/* The host SDK contract. Bumping HOST_SDK_VERSION is what tells an installed
   package it may no longer be compatible: every manifest declares the range of
   host versions it was built against, and installation refuses anything else. */

const HOST_SDK_VERSION = '1.0.0';
const PACKAGE_FORMAT = 1;
const CATALOG_VERSION = 1;

/* Capabilities a module may request. A capability is a promise the host makes to
   the module AND a line the user is shown before installing, so each one is
   described in the words the marketplace displays. */
const CAPABILITIES = {
  'ui:pages': 'Add pages, navigation entries and views',
  'ui:commands': 'Add commands and search results',
  'ui:settings': 'Add a settings section',
  'assistant:tools': 'Give the AI assistant new tools',
  'assistant:proposals': 'Handle approval cards the assistant proposes',
  /* Reading the assistant's own credential is its own privilege, and a serious
     one: it is the key to the user's AI account. It is never granted by
     "assistant:tools", it is off until the user turns it on in Settings, and the
     host hands it over one call at a time. */
  'assistant:credential': 'Use your AI sign-in to authenticate an agent it runs elsewhere',
  'storage:module': 'Store its own settings and data',
  'events:subscribe': 'Receive host events',
  'audit:read': 'Read the audit trail',
  'audit:write': 'Record audit events',
  'connections:read': 'Read connection and server profiles (no secrets)',
  'connections:secrets': 'Use stored server credentials to connect on your behalf',
  'connections:write': 'Create and edit connection and server profiles',
  'projects:read': 'Read projects and their linked resources',
  'projects:write': 'Create and change projects',
  'vault:read': 'Read stored deployment secrets',
  'vault:write': 'Store deployment secrets',
  'sockets': 'Stream live data to its own views',
  'process:exec': 'Run build and deployment commands on this machine',
  'net:outbound': 'Reach servers and services over the network',
};

/* Libraries the HOST guarantees and shares with modules that declare them.
   These are genuinely shared infrastructure - the base application needs ssh2
   for database tunnels and tar for package extraction whatever is installed -
   so a module gets the host's copy instead of shipping a second one. It also
   keeps them inside the packaged executable's snapshot, where a module's own
   node_modules could not be resolved from. */
const SHARED_DEPENDENCIES = ['ssh2', 'tar', 'express'];
const isSharedDependency = (name) => SHARED_DEPENDENCIES.includes(name);

const isKnownCapability = (name) => Object.prototype.hasOwnProperty.call(CAPABILITIES, name);
const describeCapability = (name) => CAPABILITIES[name] || name;

module.exports = { HOST_SDK_VERSION, PACKAGE_FORMAT, CATALOG_VERSION, CAPABILITIES, SHARED_DEPENDENCIES, isSharedDependency, isKnownCapability, describeCapability };
