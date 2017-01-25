// Description:
//   A Hubot script to add Toggl integration to your company's chat
//
// Commands:
//   hubot toggl setup <token> - Sets-up an user's account with Toggl
//   hubot toggl whoami - Prints the current authenticated Toggl user
//   hubot toggl show flex - Shows flex earned in current year
//   hubot toggl get flex <time slot> <working hours> - Calculates flex and absence in given time slot
//   hubot toggl log flex <time slot> <working hours> - Logs flex in given timeslot
//   hubot toggl get flex help - Prints detailed help for get flex command
//   hubot toggl log flex help - Prints detailed help for log flex command

'use strict';
var buffer = require('buffer');
var Promise = require('bluebird');
var _ = require('lodash');
var moment = require('moment');

var Buffer = buffer.Buffer;
var NO_ACCOUNT_ERROR = 'No Toggl Account set-up. Add your account with: *toggl setup <token>*';
var workspaceId = 703078;
var absenceProjectId = 30099519;
var absenceTaskName = "Compensatory time off (flex hours)";
var flexTagName = "flex";
var userAgent = "hubot";

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

Number.prototype.round = function(decimals) {
  return Number((Math.round(this + "e" + decimals)  + "e-" + decimals));
};

function hoursToSeconds(hours) {
  return hours * 60 * 60;
}

function secondsToHours(seconds) {
  return (seconds / 60 / 60).round(2);
}

function formatErrorMessage(err) {
  return '*Error:* ' + err;
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
      res.send(formatErrorMessage(err.message));
    };
  }

  function isUserAuthenticated(username) {
    var user = robot.brain.userForName(username);
    return !user || !user.toggl || !user.toggl.me;
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

  function getTimeEntries(res, start, stop) {
    return new Promise(function(resolve, reject) {
        var url = String.format("https://www.toggl.com/api/v8/time_entries?start_date={0}&end_date={1}", 
          start.toISOString(), 
          stop.toISOString());

        http(res, 'get', url)
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
            body = JSON.parse(body);
            body = body.reverse();
            for (var i in body)
              if (body[i].duration < 0)
                reject(new Error("Timer is running."));
            resolve(body);
          })
          .catch(errorHandler(res));
      });
  }
    
  function filterOutFlexEntries(timeEntries) {
    return timeEntries.filter(function(item, idx) {
      return item.tags === undefined || item.tags.indexOf(flexTagName) === -1;
    });
  }
  
  function calculateTimeLogged(timeEntries) {
    var time = 0;
    for (var i in timeEntries)
      time = time + timeEntries[i].duration;
    return time;
  }
  
  function calculateFlex(totalTime, normalTime) {
    return totalTime - normalTime;
  }
  
  function updateTimeEntriesWithFlexTag(res, entryIds) {
    http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+entryIds.join(","), {
      time_entry: {
        tags: [flexTagName],
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
    tags.push(flexTagName);
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
    
    getAbsenceTaskId(res)
      .then(function(taskId){
        http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
          time_entry: {
            pid: absenceProjectId,
            tid: taskId,
            duration: absence,
            start: timeEntries[0].start,
            created_with: "hubot"
          }
        })
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
          })
          .catch(errorHandler(res));
      })
     .catch(errorHandler(res));
  }
    
  function getFlexUsed(res) {
    return new Promise(function(resolve, reject) {
      var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&project_ids={3}&user_agent={4}", 
          workspaceId,
          moment().startOf('year').format("YYYY-MM-DD"), 
          moment().endOf('year').format("YYYY-MM-DD"),
          absenceProjectId,
          userAgent);

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
          workspaceId);

      http(res, 'get', url)
        .spread(function(httpRes, body) {
          assertStatus(200, httpRes);
          body = JSON.parse(body);
          for (var i in body){
            if (body[i].name === flexTagName)
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
            workspaceId,
            moment().startOf('year').format("YYYY-MM-DD"), 
            moment().endOf('year').format("YYYY-MM-DD"),
            tagId,
            userAgent);

          http(res, 'get', url)
            .spread(function(httpRes, body) {
              assertStatus(200, httpRes);
              body = JSON.parse(body);
              resolve(body.total_grand/1000);
            })
            .catch(errorHandler(res));
        })
        .catch(errorHandler(res));
    });  
  }
  
  function getAbsenceTaskId(res) {
    return new Promise(function(resolve, reject) {
      var url = String.format("https://www.toggl.com/api/v8/projects/{0}/tasks", absenceProjectId);

      http(res, 'get', url)
        .spread(function(httpRes, body) {
          assertStatus(200, httpRes);
          body = JSON.parse(body);
          for (var i in body){
            if (body[i].name === absenceTaskName)
              resolve(body[i].id);
          }
          res.send("Unable to log under task *" + absenceTaskName +"*. Logging under project only.");
          resolve(null);
        })
        .catch(errorHandler(res));
    });
  }
  
  function logFlex(res, entries, flex)
  {
    if (flex > 0)
      addFlex(res, entries, flex);
    else
      addAbsence(res, entries, Math.abs(flex));
  }

  function parseRequest(res) {
    var timeslotArg = res.match[1];
    var timeslotUnits = timeslotArg.slice(-1);
    var timeslot = timeslotArg.slice(0, timeslotArg.length - 1);

    var workingTimeArg = res.match[2];
    var workingTimeUnits = workingTimeArg.slice(-1);
    var workingTime = workingTimeArg.slice(0, workingTimeArg.length - 1);
    
    try {
      timeslot = parseInt(timeslot);
      workingTime = parseFloat(workingTime);
      
      if (timeslotUnits !== 'd' && timeslotUnits !== 'w')
        throw 'Use _w_ for weeks or _d_ for days in _time slot_. E.g -2d or -3w';
      if (workingTimeUnits !== 'h')
        throw 'Use _h_ (hours) for _working hours_. E.g 40h';
      if (isNaN(timeslot))
        throw '_Time slot_ must be integer.';
      if (isNaN(workingTime) || workingTime < 0)
        throw '_Working hours_ cannot be negative.';
    }
    catch(err){
      res.send(formatErrorMessage(err));
      return null;
    }
    
    var request = [];
    if (timeslotUnits === 'd')
    {
      request.start = moment().add(timeslot, 'days').startOf('day').toDate();
      request.stop = moment().add(timeslot, 'days').endOf('day').toDate();
    }
    else if (timeslotUnits === 'w')
    {
      request.start = moment().add(timeslot, 'weeks').startOf('week').toDate();
      request.stop = moment().add(timeslot, 'weeks').endOf('week').toDate();
    }
    if (workingTimeUnits === 'h')
      request.workingTime = hoursToSeconds(workingTime);
    return request;
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
          me: body
        };
        robot.brain.save();
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/toggl whoami/, function(res) {
    var user = robot.brain.userForName(res.envelope.user.name);
    if (!user || !user.toggl || !user.toggl.me){
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
  
  robot.respond(/toggl get flex (.*) (.*)/, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    
    var request = parseRequest(res);
    if (!request)
      return;

    getTimeEntries(res, request.start, request.stop)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, request.workingTime);
        res.send(secondsToHours(flex) + " hours of flex found");
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/toggl log flex (.*) (.*)/, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    
    var request = parseRequest(res);
    if (!request)
      return;

    getTimeEntries(res, request.start, request.stop)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, request.workingTime);
        logFlex(res, entries, flex);
        res.send(secondsToHours(flex) + " hours of flex logged");
      })
      .catch(errorHandler(res));
  });

  robot.respond(/toggl show flex/, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    
    getFlexEarned(res)
      .then(function(flexEarned) {
        getFlexUsed(res)
          .then(function(flexUsed) {
            var flexRemaining = flexEarned - flexUsed;
            res.send(secondsToHours(flexRemaining) + " hours of flex" + (flexRemaining < 0 ? "" : " remaining"));
        });
      })
      .catch(errorHandler(res));
  });
    
  robot.respond(/toggl get flex help/, function(res) {
    var message = 
      "get flex <time slot> <working hours>\n" +
      "Reports flex and absence in given time slot based on working hours.\n" +
      "_time slot_ - Relative time period to calculate the flex from. e.g -1w for previous week\n" +
      "_working hours_ - Normal working hours in this time slot. e.g 40h for 40 hours";
    res.send(message);
  });

  robot.respond(/toggl log flex help/, function(res) {
    var message = 
      "log flex <time slot> <working hours>\n" +
      "Logs flex and absence in given time slot based on working hours. Negative flex will be logged under absence.\n" +
      "_time slot_ - Relative time period to calculate the flex from. e.g -1w for previous week\n" +
      "_working hours_ - Normal working hours in this time slot. e.g 40h for 40 hours";
    res.send(message);
  });
  
}

exports = module.exports = hubotToggl;
