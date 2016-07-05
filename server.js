var request = require('request');
var zlib = require('zlib');
var cron = require('node-cron');
var trim = require('trim');
var zendesk = require('node-zendesk');
var htmlToText = require('html-to-text');

// SETUP: zendesk
var zendeskclient = zendesk.createClient({
    username: 'YOUR ZENDESK EMAIL ACCOUNT',
    token: 'YOUR ZENDESK TOKEN',
    remoteUri: 'https://YOUDOMAIN.zendesk.com/api/v2',
});

// SETUP: Stackoverflow
// 1. tags being monitored
var TAGS = 'semi-colon list of tags to monitor';
// 2. developer key
var STACKOVERFLOW_DEVELOPER_KEY = 'YOUR STACKOVERFLOW KEY (PUBLIC)'; // this is used for quota
// 3. checking interval
var INTERVAL = 10; // runs every minute interval

cron.schedule('*/' + INTERVAL + ' * * * *', function () {
    getNewQuestions();
});

function getNewQuestions() {
    console.log('Searching for new questions - ' + (new Date()).toString());

    // time range: 5 days back
    var now = new Date();
    var before = new Date(now - 60000 * 60 * 24 * 5);

    // create a list of tags
    var listOfTags = TAGS.split(';');

    // stackoverflow return questions for 1 tag at a time
    // is we pass 2 or more tags, will return questions with all tags
    // so let's create a list and store all questions for all
    // monitored tags. once all requests are done, proccess them
    var listOfQuestions = {};
    var pendingRequests = 0;
    listOfTags.forEach(function (tag, index) {
        var url = 'https://api.stackexchange.com/2.2/questions?fromdate=' + Math.floor(before.getTime() / 1000)
            + '&todate=' + Math.floor(now.getTime() / 1000)
            + '&order=desc&sort=activity&tagged=' + tag
            + '&site=stackoverflow&filter=withbody';

        pendingRequests++;
        makeRequest(url, function (res) {
            if (res.items != null) {
                res.items.forEach(function (question) {
                    listOfQuestions[question.question_id] = question;
                });
                pendingRequests--;
                if (pendingRequests == 0) {
                    // all requests are done, let' process
                    processQuestions(listOfQuestions);
                }
            }
        });
    });
}

function processQuestions(questions) {
    for (var id in questions) {
        (function (question) { // this access mutable variable from closure
            var title = question.title;
            var body = question.body;
            var stackuser = question.owner;
            // get or create zendesk user for this question
            getZendeskUser(stackuser, function (zendeskuser) {
                if (zendeskuser != null) {
                    // get or create zendesk ticket
                    createZendeskTicket(question, zendeskuser, function (ticket) {
                        // all set
                    })
                }
            });
        })(questions[id]);
    }
}

function getZendeskUser(stackuser, onuser) {
    // first check if the user exists...
    zendeskclient.users.search({external_id: stackuser.user_id}, function (err, req, users) {
        if (users.length == 0) {
            // if not, then create
            // (use stackoverflow user ID as zendesk end-user external ID
            var user = {
                'user': {
                    'name': stackuser.display_name,
                    'external_id': stackuser.user_id,
                    'role': 'end-user',
                    'verified': 'true',
                    'remote_photo_url': stackuser.profile_image,
                    'user_fields': {
                        'stackoverflow_profile': stackuser.link
                    },
                }
            };
            zendeskclient.users.create(user, function (err, req, newuser) {
                console.log('New end-user for user ' + stackuser.user_id);
                onuser(newuser);
            });
        }
        else
            onuser(users[0]);
    });
}

function createZendeskTicket(stackquestion, zendeskuser, onnewticket) {
    // check if the question is already logged (as a ticket)
    zendeskclient.tickets.show({external_id: stackquestion.question_id}, function (err, req, tickets) {
        if (tickets.length == 0) {
            // if not, create a new ticket with the question information
            // (use stackoverflow question ID as zendesk ticket external ID
            var ticket =
            {
                "ticket": {
                    "subject": htmlToText.fromString(stackquestion.title),
                    "comment": {
                        "html_body": // this header will remember agents to not reply on zendesk UI
                        '<h3><span style="color: red">IMPORTANT:</span> answer at '
                        + '<a href="' + stackquestion.link + '" target="_blank">Stackoverflow</a></h3>'
                        + '-----------------------------------------------------------------------------------'
                        // the actual question body
                        + stackquestion.body,
                    },
                    'requester_id': zendeskuser.id,
                    'tags': stackquestion.tags,
                    'external_id': stackquestion.question_id,
                    // if it was already answered on Stackoverflow, just mark as SOLVED.
                    // if there are some answers, mark as OPEN
                    // otherwise mark as NEW
                    'status': (stackquestion.is_answered == true ? 'solved' : (stackquestion.answer_count > 0 ? 'open' : 'new')),
                    'created_at': new Date(stackquestion.creation_date * 1000).getTime(),
                }
            };
            zendeskclient.tickets.create(ticket, function (err, req, newticket) {
                console.log('New ticket for question ' + stackquestion.question_id);
                onnewticket(newticket);
            });
        }
        else
            onnewticket(tickets[0]);
    });
}

// util function for stackoverflow requests
function makeRequest(url, onsuccess) {
    request({
        url: url + '&key=' + STACKOVERFLOW_DEVELOPER_KEY,
        method: 'GET',
        gzip: true,
    }, function (error, response, body) {
        if (error != null) console.log(error); // connection problems
        body = JSON.parse(trim(body));
        if (body.errors != null || response.statusCode != 200) {
            console.log(body.quota_remaining);
            console.log(body.errors);
        }
        onsuccess(body);
    })
}

// first run
console.log('Running every ' + INTERVAL + ' minutes for tags: ' + TAGS);
getNewQuestions();
