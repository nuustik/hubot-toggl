// Description:
//   A Hubot script to add Toggl integration to your company's chat
//
// Commands:
//   hubot toggl setup - Sets-up an user's account with Toggl
//   hubot toggl start <description> - Starts a time-entry
//   hubot toggl stop - Stops the current time-entry
//   hubot toggl current - Prints the current time-entry
//   hubot toggl whoami - Prints the current authenticated Toggl user
//   hubot toggl projects - Prints the 5 most recently modified projects

'use strict';
var buffer = require('buffer');
var Promise = require('bluebird');
var _ = require('lodash');
var moment = require('moment');

var Buffer = buffer.Buffer;
var NO_ACCOUNT_ERROR = 'No Toggl Account set-up. Add your account with: *toggl setup <token>*';

function hubotToggl(robot) {
  robot.logger.info("hubot-toggl: Starting the Toggl robot");

  function assertStatus(status, httpRes) {
    if(httpRes.statusCode !== status) {
      throw new Error(
        'Request failed with the Toggl API (HTTP ' + httpRes.statusCode + ')'
      );
    }
  }

  function errorHandler(res) {
    return function(err) {
      res.send('*Error:* ' + err.message);
    };
  }

  function http(res, method, url, body) {
    var token;
    var authorization;
    var req = robot.http(url);

    if(res) {
      if(_.isString(res)) {
        token = res;
      } else {
        var user = robot.brain.userForName(res.envelope.user.name);
        token = user && user.toggl && user.toggl.me && user.toggl.me.data.api_token;
      }

      if(!token) {
        return Promise.reject(new Error(NO_ACCOUNT_ERROR));
      }

      var base64Token = new Buffer(token + ':api_token').toString('base64');
      authorization = 'Basic ' + base64Token;
      req = req.header('Authorization', authorization);
    }

    if(method !== 'get') {
      body = JSON.stringify(body);
    }
    req = req.header('Content-Type', 'application/json');

    return new Promise(function(fulfill, reject) {
      req[method](body)
        (function(err, res, body) {
          if(err) reject(err);
          else fulfill([res, body]);
        });
    });
  }

  robot.respond(/toggl setup( (.*))?/, function(res) {
    var token = res.match[2];

    if(!robot.adapter.client.rtm.dataStore.getDMById(res.message.room)) {
      res.reply('I can only authenticate you with a Private Message');
      robot.send({room: res.message.room}, 'Send me *toggl setup <token>*');
      return;
    }

    var username = res.envelope.user.name;

    if(!token) {
      res.send('Missing token. Send me *toggl setup <token>*.');
      return;
    }

    var user = robot.brain.userForName(username);
    res.send('Validating your token');
    http(token, 'get', 'https://toggl.com/api/v8/me')
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        res.send(
          'Authenticated as: *' + body.data.fullname + '*\n' +
          'User ID: *' + body.data.id + '*\n' +
          'Default Workspace ID: *' + body.data.default_wid + '*'
        );
        user.toggl = {
          me: body,
        };
        robot.brain.save();
      })
      .catch(errorHandler(res));
  });

  robot.respond(/toggl whoami/, function(res) {
    var username = res.envelope.user.name;
    var user = robot.brain.userForName(username);

    if(!user || !user.toggl || !user.toggl.me) {
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    var me = user.toggl.me;
    res.send(
      'Authenticated as: *' + me.data.fullname + '*\n' +
      'User ID: *' + me.data.id + '*\n' +
      'Default Workspace ID: *' + me.data.default_wid + '*'
    );
  });

  robot.respond(/toggl current/, function(res) {
    var username = res.envelope.user.name;
    var user = robot.brain.userForName(username);

    if(!user || !user.toggl || !user.toggl.me) {
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    http(res, 'get', 'https://toggl.com/api/v8/time_entries/current')
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);

        if(!body.data) {
          res.send(
            'No current time-entry found. Try *toggl start <description>*'
          );
          return;
        }

        res.send(
          'Description: *' + body.data.description + '*\n' +
          'Started at: *' + body.data.start + '*'
        );
      })
      .catch(errorHandler(res));
  });

  robot.respond(/toggl start( (.*))?/, function(res) {
    var username = res.envelope.user.name;
    var user = robot.brain.userForName(username);

    if(!user || !user.toggl || !user.toggl.me) {
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    http(res, 'post', 'https://toggl.com/api/v8/time_entries', {
      time_entry: {
        description: res.match[2],
        start: moment().format(),
        created_with: 'hubot',
        duration: - new Date().getTime() / 1000
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        res.send('Started time-entry *(https://toggl.com/api/v8/time_entries/' + body.data.id + ')*');
      })
      .catch(errorHandler(res));
  });

  robot.respond(/toggl stop/, function(res) {
    var username = res.envelope.user.name;
    var user = robot.brain.userForName(username);

    if(!user || !user.toggl || !user.toggl.me) {
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    http(res, 'get', 'https://toggl.com/api/v8/time_entries/current')
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);

        if(!body.data) {
          throw new Error('No current time-entry to stop');
        }

        var currentId = body.data.id;
        var url = 'https://toggl.com/api/v8/time_entries/' + currentId;
        return http(res, 'put', url, {
          time_entry: _.extend(body.data, {
            stop: moment().format(),
            duration:
            (new Date().getTime() -
             moment.parseZone(body.data.start).toDate().getTime()) /
              1000
          }),
        });
      })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        res.send('Stopped time-entry *(https://toggl.com/api/v8/time_entries/' + body.data.id + ')*');
      })
      .catch(errorHandler(res));
  });

  robot.respond(/toggl projects/, function(res) {
    var username = res.envelope.user.name;
    var user = robot.brain.userForName(username);

    if(!user || !user.toggl || !user.toggl.me) {
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    var me = user.toggl.me;
    var projectsUrl = 'https://toggl.com/api/v8/workspaces/' +
      me.data.default_wid +
      '/projects';

    res.send('Finding the last 5 projects to be updated');
    http(res, 'get', projectsUrl)
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        res.send(
          _(body)
            .sortBy(function(project) {
              return moment.parseZone(project.at).toDate().getTime();
            })
            .reverse()
            .take(5)
            .map('name')
            .map(function(n) {
              return '• ' + n;
            })
            .value()
            .join('\n')
        );
      })
      .catch(errorHandler(res));
  });
}

exports = module.exports = hubotToggl;
