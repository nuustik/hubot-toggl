// Description:
//   A Hubot script to add Toggl integration to your company's chat
//
// Commands:
//   setup <token> - Sets-up an user's account with Toggl
//   whoami - Prints the current authenticated Toggl user
//   show flex - Shows flex earned in this year
//   get flex <time slot> <working hours> - Reports flex in given time slot
//   log flex <time slot> <working hours> - Logs flex in given time slot

'use strict';
var buffer = require('buffer');
var Promise = require('bluebird');
var _ = require('lodash');
var moment = require('moment');

var Buffer = buffer.Buffer;
var NO_ACCOUNT_ERROR = 'No Toggl Account set-up. Add your account with: *toggl setup <token>*';
var workspaceId = 1815032;
var absenceProjectId = 27669326;
var absenceTaskName = "Compensatory time off (flex hours)";
var flexTagName = "Flex";
var userAgent = "hubot";
var userData = new Object();

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

function getHelpForGetFlex() {
  var message = 
    "Send me *get flex <time slot> <working hours>*\n" +
    "_time slot_ - Relative time period to calculate the flex from. E.g -1w for previous week.\n" +
    "_working hours_ - Normal working hours in this time slot. E.g 40h for 40 hours.";
  return message;
}

function getHelpForLogFlex() {
  var message = 
    "Send me *log flex <time slot> <working hours>*\n" +
    "_time slot_ - Relative time period to calculate the flex from. E.g -1w for previous week.\n" +
    "_working hours_ - Normal working hours in this time slot. E.g 40h for 40 hours.";
  return message;
}
  
function hubotToggl(robot) {
  robot.logger.info("hubot-toggl: Starting the Toggl robot");
 
  robot.respond(/setup( (.*))?/i, function(res) {
    var token = res.match[2];

    if(!robot.adapter.client.rtm.dataStore.getDMById(res.message.room)) {
      res.reply('I can only authenticate you with a Private Message');
      robot.send({room: res.message.room}, 'Send me *setup <token>*');
      return;
    }

    var userId = res.envelope.user.id;

    if(!token) {
      res.send('Missing token. Send me *toggl setup <token>*.');
      return;
    }

    var user = robot.brain.userForId(userId);
    res.send('Validating your token');
    return http(token, 'get', 'https://toggl.com/api/v8/me')
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
  
  robot.respond(/whoami$/i, function(res) {
    var user = robot.brain.userForId(res.envelope.user.id);
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
  
  robot.respond(/get flex( +([^\s]+) +([^\s]+))?/i, function(res) {
    var userId = res.envelope.user.id;
    if (isUserAuthenticated(userId)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    
    Promise.resolve()
      .then(function() { 
        return parseArguments(res, getHelpForGetFlex()); 
      })
      .then(function(request){ 
        return getFlex(res, request);
      })
      .then(function(result) {
        if (result.flex !== 0)
        {
          storeUserData(userId, result);
          res.send(String.format("{0} hours of flex found. Do you want to log it{1}?", 
            secondsToHours(result.flex),
            result.flex < 0 ? " as absence" : "")
          );
        }
        else
          res.send("No flex found. Everything is perfect!");
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/log flex( +([^\s]+) +([^\s]+))?/i, function(res) {
    if (isUserAuthenticated(res.envelope.user.id)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    Promise.resolve()
      .then(function() {
        return parseArguments(res, getHelpForLogFlex());
      })
      .then(function(request){ 
        return getFlex(res, request);
      })
      .then(function(result) {
        if (result.flex) {
          logFlex(res, result)
            .then(function(flex){
              res.send(String.format("{0} hours of flex logged.", 
                secondsToHours(flex))
              );
            });
        }
        else
          res.send("Nothing to log. You have 0 hours of flex.");
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/yes\b$|y\b$|ok\b$/i, function(res) {
    var userId = res.envelope.user.id;
    if (isUserAuthenticated(userId)){
      return;
    }
    
    var data = getUserData(userId);
    if (!data)
      return;

    clearUserData(userId);
    getFlex(res, data.request)
      .then(function(result){
        if (result.flex === data.flex){
          return logFlex(res, result)
            .then(function(flex){
              res.send(String.format("{0} hours of flex logged.", 
                secondsToHours(flex))
              );
            });
        }
        else
          throw new Error("The amount of flex has changed. Please try again.");
      })
      .catch(function(err){
        clearUserData(userId);
        errorHandler(res)(err);
      });
  });

  robot.respond(/show flex$/i, function(res) {
    if (isUserAuthenticated(res.envelope.user.id)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    getFlexEarned(res)
      .then(function(flexEarned) {
        return getFlexUsed(res)
          .then(function(flexUsed) {
            var flexRemaining = flexEarned - flexUsed;
            res.send(String.format("You have {0} hours of flex{1}.", 
              secondsToHours(flexRemaining), 
              flexRemaining < 0 ? "" : " remaining")
            );
        });
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/help/i, function(res) {
    var message = 
      "setup <token> - Sets-up an user's account with Toggl\n" +
      "whoami - Prints the current authenticated Toggl user\n" +
      "show flex - Shows flex account of this year\n" +
      "get flex <time slot> <working hours> - Reports flex in given time slot based on working hours\n" +
      "log flex <time slot> <working hours> - Logs flex in given time slot based on working hours\n";
    res.send(message);
  });
  
  robot.hear(/^(?!.*(yes\b$|y\b$|ok\b$))/i, function(res) {
    var userId = res.envelope.user.id;
    if (isUserAuthenticated(userId)){
      return;
    }
    clearUserData(userId);
  });
  
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

  function isUserAuthenticated(userId) {
    var user = robot.brain.userForId(userId);
    return !user || !user.toggl || !user.toggl.me;
  }
   
  function parseArguments(res, helpMessage) {
    if (res.match[1] === undefined)
      throw Error(helpMessage);
    
    var timeslotArg = res.match[2];
    var timeslotUnits = timeslotArg.slice(-1);
    var timeslot = timeslotArg.slice(0, timeslotArg.length - 1);

    var workingTimeArg = res.match[3];
    var workingTimeUnits = workingTimeArg.slice(-1);
    var workingTime = workingTimeArg.slice(0, workingTimeArg.length - 1);

    timeslot = parseInt(timeslot);
    workingTime = parseFloat(workingTime);

    if (isNaN(timeslot))
      throw Error('_Time slot_ must be integer.');
    if (timeslotUnits !== 'd' && timeslotUnits !== 'w')
      throw new Error('_Time slot_ must use _w_ for weeks or _d_ for days. E.g -2d or -3w');
    if (isNaN(workingTime) || workingTime < 0)
      throw Error('_Working hours_ must be positive number.');
    if (workingTimeUnits !== 'h')
      throw Error('_Working hours_ must use _h_ for hours. E.g 40h');
    
    var request = [];
    if (timeslotUnits === 'd')
    {
      request.start = moment().add(timeslot, 'days').startOf('day').toISOString();
      request.stop = moment().add(timeslot, 'days').endOf('day').toISOString();
    }
    else if (timeslotUnits === 'w')
    {
      request.start = moment().add(timeslot, 'weeks').startOf('isoweek').toISOString();
      request.stop = moment().add(timeslot, 'weeks').endOf('isoweek').toISOString();
    }
    if (workingTimeUnits === 'h')
      request.workingTime = hoursToSeconds(workingTime);
    return request;
  }
  
  function clearUserData(user) {
    delete userData[user];
  }
  
  function getUserData(user) {
    return userData[user];
  }
  
  function storeUserData(user, result) {
    var data = {
      request: result.request,
      flex: result.flex
    };
    userData[user] = data;
  }
  
  function http(res, method, url, body) {
    var token;
    var authorization;
    var req = robot.http(url);

    if(res) {
      if(_.isString(res)) {
        token = res;
      } else {
        var user = robot.brain.userForId(res.envelope.user.id);
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

  function getFlex(res, request) {
    return getTimeEntries(res, request.start, request.stop)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, request.workingTime);
        var result = {
          request: {
            start: request.start,
            stop: request.stop,
            workingTime: request.workingTime
          },
          entries: entries,
          flex: flex
        };
        return result;
      });
  }
  
  function getTimeEntries(res, start, stop) {
    var url = String.format("https://www.toggl.com/api/v8/time_entries?start_date={0}&end_date={1}", 
      start, 
      stop);

    return http(res, 'get', url)
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        body = body.reverse();
        for (var i in body)
          if (body[i].duration < 0)
            throw new Error("Timer is running.");
        return body;
      });
  }
    
  function filterOutFlexEntries(timeEntries) {
    return timeEntries.filter(function(item) {
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
    return http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+entryIds.join(","), {
      time_entry: {
        tags: [flexTagName],
        tag_action: 'add'
      }
    })
      .spread(function(httpRes) {
        assertStatus(200, httpRes);
      });
  }
  
  function modifyOldEntry(res, timeEntry, flex) {
    timeEntry.duration = timeEntry.duration - flex;
    timeEntry.stop = moment(timeEntry.start).add(timeEntry.duration, 'seconds');
    return http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+timeEntry.id, {
      time_entry: timeEntry
    })
      .spread(function(httpRes) {
        assertStatus(200, httpRes);
      });
  }
  
  function addNewEntry(res, timeEntry, flex) {
    var tags = timeEntry.tags !== undefined ? timeEntry.tags : [];
    tags.push(flexTagName);
    return http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
      time_entry: {
        description: timeEntry.description,
        duration: flex,
        start: timeEntry.start,
        stop: timeEntry.stop,
        created_with: "hubot",
        tags: tags,
        wid: timeEntry.wid,
        pid: timeEntry.pid,
        tid: timeEntry.tid
      }
    })
      .spread(function(httpRes) {
        assertStatus(200, httpRes);
      });
  }
  
  function splitTimeEntry(res, timeEntry, flexInSeconds) {
    return addNewEntry(res, timeEntry, flexInSeconds)
      .then(function() {
        return modifyOldEntry(res, timeEntry, flexInSeconds);        
      });
  }
  
  function addFlex(res, timeEntries, flex) {
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
    
    var todo = [];
    if (toBeUpdated.length > 0)
      todo.push(updateTimeEntriesWithFlexTag(res, toBeUpdated));
    if (toBeSplit)
      todo.push(splitTimeEntry(res, toBeSplit, flexRemaining));
    
    return Promise.all(todo).then(function(){ 
      return flex; 
    });
  }
  
  function addAbsence(res, start, flex) {
    return getAbsenceTaskId(res)
      .then(function(taskId){
        return http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
          time_entry: {
            wid: workspaceId,
            pid: absenceProjectId,
            tid: taskId,
            duration: Math.abs(flex),
            start: start,
            created_with: "hubot"
          }
        })
          .spread(function(httpRes) {
            assertStatus(200, httpRes);
            return flex;
          });
      });
  }
    
  function getFlexUsed(res) {
    return getAbsenceTaskId(res)
      .then(function(taskId){
        var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&project_ids={3}&task_ids={4}&user_agent={5}", 
            workspaceId,
            moment().startOf('year').format("YYYY-MM-DD"), 
            moment().endOf('year').format("YYYY-MM-DD"),
            absenceProjectId,
            taskId,
            userAgent);

        return http(res, 'get', url)
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
            body = JSON.parse(body);
            return body.total_grand/1000;
          });
    });
  }
  
  function getFlexTagId(res) {
    var url = String.format("https://www.toggl.com/api/v8/workspaces/{0}/tags", 
        workspaceId);

    return http(res, 'get', url)
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        for (var i in body){
          if (body[i].name === flexTagName)
            return body[i].id;
        }
        throw new Error("Unable to find tag named '" + flexTagName + "'");
      });
  }
  
  function getFlexEarned(res) {
    return getFlexTagId(res)
      .then(function(tagId) {
        var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&tag_ids={3}&user_agent={4}", 
          workspaceId,
          moment().startOf('year').format("YYYY-MM-DD"), 
          moment().endOf('year').format("YYYY-MM-DD"),
          tagId,
          userAgent);

        return http(res, 'get', url)
          .spread(function(httpRes, body) {
            assertStatus(200, httpRes);
            body = JSON.parse(body);
            return body.total_grand/1000;
          });
      });
  }
  
  function getAbsenceTaskId(res) {
    var url = String.format("https://www.toggl.com/api/v8/projects/{0}/tasks", absenceProjectId);

    return http(res, 'get', url)
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
        body = JSON.parse(body);
        for (var i in body){
          if (body[i].name === absenceTaskName)
            return body[i].id;
        }
        throw new Error("Cannot find task '" + absenceTaskName + "'");
      });
  }
  
  function logFlex(res, result) {
    if (result.flex > 0)
      return addFlex(res, result.entries, result.flex);
    else
    {
      var start = (result.entries.length === 0) ? result.request.start : result.entries[0].start;
      return addAbsence(res, start, result.flex);
    }
  }

}

exports = module.exports = hubotToggl;
