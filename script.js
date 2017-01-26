// Description:
//   A Hubot script to add Toggl integration to your company's chat
//
// Commands:
//   setup <token> - Sets-up an user's account with Toggl
//   whoami - Prints the current authenticated Toggl user
//   show flex - Shows flex earned in current year
//   get flex <time slot> <working hours> - Calculates flex and absence in given time slot
//   log flex <time slot> <working hours> - Logs flex in given timeslot

'use strict';
var buffer = require('buffer');
var Promise = require('bluebird');
var _ = require('lodash');
var moment = require('moment');

var Buffer = buffer.Buffer;
var NO_ACCOUNT_ERROR = 'No Toggl Account set-up. Add your account with: *toggl setup <token>*';
var workspaceId = 1815032;//1815032; //my 703078;
var absenceProjectId = 27669326;//27669326; //my 30099519;
var absenceTaskName = "Compensatory time off (flex hours)";
var flexTagName = "Flex";//Flex; //my flex;
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

function getHelpForGetFlex() {
  var message = 
    "Send me *get flex <time slot> <working hours>*\n" +
    "Reports flex and absence in given time slot based on working hours.\n" +
    "_time slot_ - Relative time period to calculate the flex from. E.g -1w for previous week\n" +
    "_working hours_ - Normal working hours in this time slot. E.g 40h for 40 hours";
  return message;
}

function getHelpForLogFlex() {
  var message = 
    "Send me *log flex <time slot> <working hours>*\n" +
    "Logs flex and absence in given time slot based on working hours. Negative flex is logged under absence.\n" +
    "_time slot_ - Relative time period to calculate the flex from. E.g -1w for previous week\n" +
    "_working hours_ - Normal working hours in this time slot. E.g 40h for 40 hours";
  return message;
}
  
function hubotToggl(robot) {
  robot.logger.info("hubot-toggl: Starting the Toggl robot");
 
  robot.respond(/setup( (.*))?/i, function(res) {
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
      });
  });
  
  robot.respond(/whoami/i, function(res) {
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
  
  robot.respond(/get flex( (.*))?/i, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    
    var request = null;
    try {   
      var args = parseArgument(res, getHelpForGetFlex());
      request = parseArguments(args, res);
    }
    catch(err){
      res.send(formatErrorMessage(err.message));
      return;
    }
    
    getTimeEntries(res, request.start, request.stop)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, request.workingTime);
        res.send(secondsToHours(flex) + " hours of flex found");
      })
      .catch(errorHandler(res));
  });
  
  robot.respond(/log flex( (.*))?/i, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }

    var request = null;
    try {   
      var args = parseArgument(res, getHelpForLogFlex());
      request = parseArguments(args, res);
    }
    catch(err){
      res.send(formatErrorMessage(err.message));
      return;
    }

    getTimeEntries(res, request.start, request.stop)
      .then(function(entries){
        entries = filterOutFlexEntries(entries);
        var timeLogged = calculateTimeLogged(entries);
        var flex = calculateFlex(timeLogged, request.workingTime);
        if (flex){
          return logFlex(res, entries, flex)
            .then(function(){ 
              res.send(secondsToHours(flex) + " hours of flex logged"); 
            });
        }
        else res.send("You have 0 hours of flex. Nothing to log");
      })
      .catch(errorHandler(res));
  });

  robot.respond(/show flex/i, function(res) {
    if (isUserAuthenticated(res.envelope.user.name)){
      res.send(NO_ACCOUNT_ERROR);
      return;
    }
    getFlexEarned(res)
      .then(function(flexEarned) {
        return getFlexUsed(res)
          .then(function(flexUsed) {
            var flexRemaining = flexEarned - flexUsed;
            res.send("You have " + secondsToHours(flexRemaining) + " hours of flex" + (flexRemaining < 0 ? "" : " remaining"));
        });
      })
      .catch(errorHandler(res));
  });

  robot.respond(/help/i, function(res) {
    var message = 
      "setup <token> - Sets-up an user's account with Toggl\n" +
      "whoami - Prints the current authenticated Toggl user\n" +
      "show flex - Shows flex account of this year\n" +
      "get flex <time slot> <working hours> - Calculates flex in given time slot\n" +
      "log flex <time slot> <working hours> - Logs flex and absence in given time slot\n";
    res.send(message);
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

  function isUserAuthenticated(username) {
    var user = robot.brain.userForName(username);
    return !user || !user.toggl || !user.toggl.me;
  }
   
  function parseArguments(args, res) {
    var timeslotArg = args[0];
    var timeslotUnits = timeslotArg.slice(-1);
    var timeslot = timeslotArg.slice(0, timeslotArg.length - 1);

    var workingTimeArg = args[1];
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
  
  function parseArgument(res, help) {
    if (!res.match[2])
      throw new Error('Too few arguments.\n' + help);
    var args = res.match[2].trim().split(' ');
    if (args.length < 2)
      throw Error('Too few arguments..\n' + help);
    if (args.length > 2)
      throw Error('Too many arguments.\n' + help);
    return args;
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
          .catch(function(err) { reject(err); });
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
    return http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+entryIds.join(","), {
      time_entry: {
        tags: [flexTagName],
        tag_action: 'add'
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      });
  }
  
  function modifyOldEntry(res, timeEntry, flex) {
    return http(res, 'put', 'https://www.toggl.com/api/v8/time_entries/'+timeEntry.id, {
      time_entry: {
        duration: timeEntry.duration - flex
      }
    })
      .spread(function(httpRes, body) {
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
        tags: tags
      }
    })
      .spread(function(httpRes, body) {
        assertStatus(200, httpRes);
      });
  }
  
  function splitTimeEntry(res, timeEntry, flexInSeconds) {
    return addNewEntry(res, timeEntry, flexInSeconds)
      .then(function(res) {
        return modifyOldEntry(res, timeEntry, flexInSeconds);        
      });
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
      return updateTimeEntriesWithFlexTag(res, toBeUpdated);
    if (toBeSplit)
      return splitTimeEntry(res, toBeSplit, flexRemaining);
  }
  
  function addAbsence(res, timeEntries, absence) {
    return getAbsenceTaskId(res)
      .then(function(taskId){
        return http(res, 'post', 'https://www.toggl.com/api/v8/time_entries', {
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
          });
      });
  }
    
  function getFlexUsed(res) {
    return new Promise(function(resolve, reject) {
      getAbsenceTaskId(res)
        .then(function(taskId){
          var url = String.format("https://toggl.com/reports/api/v2/summary?workspace_id={0}&since={1}&until={2}&project_ids={3}&task_ids={4}&user_agent={5}", 
              workspaceId,
              moment().startOf('year').format("YYYY-MM-DD"), 
              moment().endOf('year').format("YYYY-MM-DD"),
              absenceProjectId,
              taskId,
              userAgent);

          http(res, 'get', url)
            .spread(function(httpRes, body) {
              assertStatus(200, httpRes);
              body = JSON.parse(body);
              resolve(body.total_grand/1000);
            })
            .catch(function(err){ reject(err); });
      })
      .catch(function(err){ reject(err); });
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
          reject(new Error("Unable to find tag named '" + flexTagName + "'"));
        })
        .catch(function(err) { reject(err); });
    });
  }
  
  function getFlexEarned(res) {
    return new Promise(function(resolve, reject) {
      return getFlexTagId(res)
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
            .catch(function(err) { reject(err); });
        })
        .catch(function(err) { reject(err); });
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
          reject(new Error("Cannot find task '" + absenceTaskName + "'"));
        })
        .catch(function(err) { reject(err); });
    });
  }
  
  function logFlex(res, entries, flex)
  {
    if (flex > 0)
      return addFlex(res, entries, flex);
    else
      return addAbsence(res, entries, Math.abs(flex));
  }

}

exports = module.exports = hubotToggl;
