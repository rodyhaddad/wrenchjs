/* global require, module */

var Angular2App = require('wrenchjs/lib/broccoli/angular2-app');

var app = new Angular2App();

module.exports = app.toTree();