// Description:
//   A Hubot script to add Toggl integration to your company's chat
//
// Commands:
//   hubot toggl setup <token> - Sets-up an user's account with Toggl
//   hubot toggl whoami - Prints the current authenticated Toggl user
//   hubot toggl show flex - Shows flex earned in current year
//   hubot toggl get flex <time slot> <working hours> - Calculates flex and absence in given time slot
//   hubot toggl log flex <time slot> <working hours> - Logs flex in given timeslot

'use strict';
var buffer = require('buffer');
var Promise = require('bluebird');
var _ = require('lodash');
var moment = require('moment');

var Buffer = buffer.Buffer;
var NO_ACCOUNT_ERROR = 'No Toggl Account set-up. Add your account with: *toggl setup <token>*';

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
    
function hoursToSeconds(hours) {
  return hours * 60 * 60;
}

function secondsToHours(seconds) {
  return seconds / 60 / 60;
}

function getAbsenceProjectId() {
    return 7701697;
}

function getAbsenceTaskId() {
    return 0;
}

function getWorkspaceId() {
  return 703078;
}

function getFlexTag() {
  return 'flex';
}
  
function getUserAgent() {
  return "hubot";
}
  
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
  
  robot.respond(/toggl setup/, function(res) {
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
  
  function getTimeEntries(res, time) {
    return new Promise(function(resolve, reject) {
        var url = String.format("https://www.toggl.com/api/v8/time_entries?start_date={0}&end_date={1}", 
          time.start.toISOString(), 
          time.end.toISOString());

        http(res, 'get', url)
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
            body = JSON.parse(body);
            resolve(body);
          })
          .catch(errorHandler(res));
      });
  }
    
  function filterOutFlexEntries(timeEntries) {
    return timeEntries.filter(function(item, idx) {
      return item.tags === undefined || item.tags.indexOf(getFlexTag()) === -1;
    });
  }
  
  function calculateTimeLogged(timeEntries) {
    var time = 0;
    for (var i in timeEntries)
      time = time + timeEntries[i].duration;
    return time;
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
  
  function calculateFlex(totalTime, normalTime) {
    return totalTime > normalTime ? totalTime - normalTime : 0;
  }
  
  function calculateAbsence(totalTime, normalTime) {
    return totalTime < normalTime ? normalTime - totalTime : 0;
  }
  
  function sendReport(res, flex, absence) {
    res.send(secondsToHours(flex) + " hours of flex");
    res.send(secondsToHours(absence) + " hours of absence");
  }
  
  function updateTimeEntriesWithFlexTag(res, entryIds) {
    http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+entryIds.join(","), {
      time_entry: {
        tags: [getFlexTag()],
        tag_action: 'add'
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      })
      .catch(errorHandler(res));
  }
  
  function modifyOldEntry(res, timeEntry, flex) {
    http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+timeEntry.id, {
      time_entry: {
        duration: timeEntry.duration - flex
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      })
      .catch(errorHandler(res));
  }
  
  function addNewEntry(res, timeEntry, flex) {
    var tags = timeEntry.tags !== undefined ? timeEntry.tags : [];
    tags.push(getFlexTag());
    http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
      time_entry: {
        description: timeEntry.description,
        duration: flex,
        start: timeEntry.start,
        stop: timeEntry.stop,
        created_with: "hubot",
        tags: tags
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      })
      .catch(errorHandler(res));
  }
  
  function splitTimeEntry(res, timeEntry, flexInSeconds) {
    addNewEntry(res, timeEntry, flexInSeconds);
    modifyOldEntry(res, timeEntry, flexInSeconds);
  }
  
  function addFlex(res, timeEntries, flex) {
    if (!flex)
      return;
    
    var flexRemaining = flex;
    var toBeUpdated = [];
    var toBeSplit;
    
    for (var i in timeEntries) {
      if (timeEntries[i].duration <= flexRemaining){
        toBeUpdated.push(timeEntries[i].id);
        flexRemaining -= timeEntries[i].duration;
      }
      else{
        toBeSplit = timeEntries[i];
        break;
      }
    }
    
    if (toBeUpdated.length > 0)
      updateTimeEntriesWithFlexTag(res, toBeUpdated);
    if (toBeSplit)
      splitTimeEntry(res, toBeSplit, flexRemaining);
  }
  
  function addAbsence(res, timeEntries, absence) {
    if (!absence)
      return;
    
    http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
      time_entry: {
        pid: getAbsenceProjectId(),
        tid: getAbsenceTaskId(),
        duration: absence,
        start: timeEntries[0].start,
        created_with: "hubot"
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      })
      .catch(errorHandler(res));
  }
    
  function getFlexUsed(res) {
    return new Promise(function(resolve, reject) {
      var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&project_ids={3}&user_agent={4}", 
          getWorkspaceId(),
          moment().startOf('year').format("YYYY-MM-DD"), 
          moment().endOf('year').format("YYYY-MM-DD"),
          getAbsenceProjectId(),
          getUserAgent());

      http(res, 'get', url)
        .spread(function(httpRes, body) {
          assertStatus(200, httpRes);
          body = JSON.parse(body);
          resolve(body.total_grand/1000);
        })
        .catch(errorHandler(res));
    });
  }
  
  function getFlexTagId(res) {
    return new Promise(function(resolve, reject) {
      var url = String.format("https://www.toggl.com/api/v8/workspaces/{0}/tags", 
          getWorkspaceId());

      http(res, 'get', url)
        .spread(function(httpRes, body) {
          assertStatus(200, httpRes);
          body = JSON.parse(body);
          for (var i in body){
            if (body[i].name === getFlexTag())
              resolve(body[i].id);
          }
          reject("Unable to find tag named 'flex'");
        })
        .catch(errorHandler(res));
    });
  }
  
  function getFlexEarned(res) {
    return new Promise(function(resolve, reject) {
      getFlexTagId(res)
        .then(function(tagId) {
          var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&tag_ids={3}&user_agent={4}", 
            getWorkspaceId(),
            moment().startOf('year').format("YYYY-MM-DD"), 
            moment().endOf('year').format("YYYY-MM-DD"),
            tagId,
            getUserAgent());

          http(res, 'get', url)
            .spread(function(httpRes, body) {
              assertStatus(200, httpRes);
              body = JSON.parse(body);
              resolve(body.total_grand/1000);
            })
            .catch(errorHandler(res));
        }, function(error) {
          console.error("Failed!", error);
        }
      );  
    });
  }
  
  function getGetFlexHelp() {
    var message = 
      "get flex <timeslot> <working hours>\n" +
      "Reports flex and absence in given time slot based on working hours.\n" +
      "_timeslot_ - Relative time period to calculate the flex from. e.g -1w for previous week\n" +
      "_working hours_ - Normal working hours in this timeslot. e.g 40h for 40 hours";
    return message;
  }
  
  function getLogFlexHelp() {
    var message = 
      "log flex <timeslot> <working hours>\n" +
      "Logs flex and absence in given time slot based on working hours.\n" +
      "_timeslot_ - Relative time period to calculate the flex from. e.g -1w for previous week\n" +
      "_working hours_ - Normal working hours in this timeslot. e.g 40h for 40 hours";
    return message;
  }
  
  robot.respond(/toggl get flex (.*) (.*)/, function(res) {
    var request = parseParams(res);
    if (!validateRequest(request)){
      res.send(getGetFlexHelp());
      return;
    }
    var time = getRequestedTime(request.relativeTime, request.requestUnits);
    getTimeEntries(res, time)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, hoursToSeconds(request.normalHours));
        var absence = calculateAbsence(timeLogged, hoursToSeconds(request.normalHours));
        sendReport(res, flex, absence);
      });
  });
  
  robot.respond(/toggl log flex (.*) (.*)/, function(res) {
    var request = parseParams(res);
    if (!validateRequest(request)){
      res.send(getLogFlexHelp());
      return;
    }
    var time = getRequestedTime(request.relativeTime, request.requestUnits);
    getTimeEntries(res, time)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, hoursToSeconds(request.normalHours));
        var absence = calculateAbsence(timeLogged, hoursToSeconds(request.normalHours));
        addFlex(res, entries, flex);
        addAbsence(res, entries, absence);
        sendReport(res, flex, absence);
      });
  });
  
  robot.respond(/toggl get flex/, function(res) {
    res.send(getGetFlexHelp());
  });

  robot.respond(/toggl log flex/, function(res) {
    res.send(getLogFlexHelp());
  });

  robot.respond(/toggl show flex/, function(res) {
    getFlexEarned(res)
      .then(function(flexEarned) {
        getFlexUsed(res)
          .then(function(flexUsed) {
            var flexRemaining = flexEarned - flexUsed;
            res.send(secondsToHours(flexRemaining) + " hours of flex remaining");
        });
      });
  });
  
}

exports = module.exports = hubotToggl;
