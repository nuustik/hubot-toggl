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
  
  robot.respond(/x/, function(res) {
    var token = "899c26ade5e4966821a509efa30101d4"
  //robot.respond(/toggl setup( (.*))?/, function(res) {
    //var token = res.match[2];

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
  
  if (!String.format) {
    String.format = function(format) {
      var args = Array.prototype.slice.call(arguments, 1);
      return format.replace(/{(\d+)}/g, function(match, number) { 
        return typeof args[number] !== 'undefined'
          ? args[number] 
          : match
        ;
      });
    };
  }
  
  function getWorkingHours(res, fromDate, toDate) {
    return new Promise(function(resolve, reject) {
        var url = String.format("https://www.toggl.com/api/v8/time_entries?start_date={0}&end_date={1}", 
          fromDate.toISOString(), 
          toDate.toISOString());

        http(res, 'get', url)
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
            body = JSON.parse(body);
            var totalHours = 0;
            for (var i in body) {
              var start = new Date(body[i]['start']);
              var end = new Date(body[i]['stop']);
              var diff = end.valueOf() - start.valueOf();
              var diffInHours = diff/1000/60/60;
              totalHours = totalHours + diffInHours;
            }
            resolve(totalHours);
          })
          .catch(errorHandler(res));
      });
  }
  
  function parseParams(res) {
    var request = [];
    var subjectArg = res.match[1];
    request.requestUnits = subjectArg.slice(-1);
    request.relativeTime = subjectArg.slice(0, subjectArg.length - 1);

    var normalHoursArg = res.match[2];
    request.normalHoursUnits = normalHoursArg.slice(-1);
    request.normalHours = normalHoursArg.slice(0, normalHoursArg.length - 1);
    return request;
  }
  
  function validateRequest(request) {
    if (!((request.requestUnits === 'd' || request.requestUnits === 'w')  && request.normalHoursUnits === 'h'))
      return false;
    if (isNaN(parseInt(request.relativeTime)) || isNaN(parseInt(request.normalHours)))
      return false;
    return true;
  }
  
  function getRequestedTime(relativeTime, units) {
    var time = [];
    if (units === 'd'){
      time.start = moment().add(relativeTime, 'days').startOf('day').toDate();
      time.end = moment().add(relativeTime, 'days').endOf('day').toDate();
    }
    else if (units === 'w'){
      time.start = moment().add(relativeTime, 'weeks').startOf('week').toDate();
      time.end = moment().add(relativeTime, 'weeks').endOf('week').toDate();
    }
    return time;
  }
  
  function calculateFlex(totalHours, normalHours) {
    return totalHours > normalHours ? totalHours - normalHours : 0;
  }
  
  function calculateAbsence(totalHours, normalHours) {
    return totalHours < normalHours ? normalHours - totalHours : 0;
  }
  
  function sendReport(res, time, flex, absence) {
    res.send("Found " + flex + " hours of flex on " + time.start.toDateString() + " - " + time.end.toDateString());
    res.send("Found " + absence + " hours of absence on " + time.start.toDateString() + " - " + time.end.toDateString());
  }
  
  robot.respond(/f (.*) (.*)/, function(res) {
    var request = parseParams(res);
    if (!validateRequest(request)){
      res.send('Incorrect arguments. Send me *toggl calc flex <days> <hours>*');
      return;
    }
    var time = getRequestedTime(request.relativeTime, request.requestUnits);
    getWorkingHours(res, time.start, time.end)
      .then(function(hours){
        var flex = calculateFlex(hours, request.normalHours);
        var absence = calculateAbsence(hours, request.normalHours);
        sendReport(res, time, flex, absence);
      });
    
  });
  
  robot.respond(/t/, function(res) {

  });
}

exports = module.exports = hubotToggl;
